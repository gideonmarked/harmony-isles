// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { getState, dispatch, expToNextRank } from '../engine/gameState.js';
import { startRhythm, LANE_KEYS } from '../engine/rhythmEngine.js';
import { freezeFor, shakeCamera, resetTimeFx } from '../engine/timeFx.js';
import { Character } from '../entities/character.js';
import { battleHud } from '../ui/battleHud.js';
import { battleFx } from '../ui/battleFx.js';
import { rhythmUI } from '../ui/rhythmUI.js';
import { itemMenu } from '../ui/itemMenu.js';
import { songMenu } from '../ui/songMenu.js';

/**
 * Battle scene — the Jam Clash arena.
 *
 * Spawns a player and an enemy, runs a turn-based state machine, and
 * delegates the Perform action to the rhythm engine. Rhythm accuracy
 * scales the perform damage and Hype gain.
 *
 * State machine:
 *   playerTurn  → wait for Z, transition to performing
 *   performing  → rhythm round runs; on completion → resolving
 *   resolving   → apply damage + Hype, brief pause, → enemyTurn
 *   enemyTurn   → automated enemy strike, → playerTurn
 *   gameOver    → victory or defeat; Esc returns to title
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const battleScene = (() => {
  /** @typedef {'introducing' | 'playerTurn' | 'itemMenu' | 'songMenu' | 'performing' | 'resolving' | 'enemyTurn' | 'gameOver'} BattlePhase */

  const HYPE_MAX = 100;
  const PERFORM_BASE_HYPE = 15;
  const PERFORM_ACCURACY_HYPE = 25;
  const DEFEND_HYPE_GAIN = 6;
  const DEFEND_DELAY_MS = 350;
  const ENEMY_PERFORM_POWER = 1.0;

  // Strum — light filler attack with no rhythm minigame. Small damage,
  // restores Energy so the player can dig themselves out of an
  // empty-Energy hole, generates a smidge of Hype. Acts as the menu's
  // primary action; bigger hits route through Perform / Band Performance.
  const STRUM_BASE_POWER = 0.5;
  const STRUM_ENERGY_REGEN_PCT = 0.10;
  const STRUM_HYPE_GAIN = 4;
  const STRUM_DELAY_MS = 420;

  /**
   * §14.3 accuracy multiplier table. 100% accuracy *also* triggers the
   * 1.5x criticalMultiplier (applied separately) for a 3.0x net.
   *
   * @param {number} acc  0..1
   * @returns {number}
   */
  function accuracyMultiplier(acc) {
    const pct = acc * 100;
    if (pct >= 100) return 2.0;
    if (pct >= 80) return 1.5;
    if (pct >= 50) return 1.2;
    if (pct >= 1) return 1.0;
    return 0.5;
  }

  /**
   * §15.1 confidence defense — `1 + target.confidence_stat / 50`,
   * doubled when the target is defending.
   *
   * @param {Character} target
   */
  function confidenceDefense(target) {
    const base = 1 + (target.stats.confidence ?? 0) / 50;
    return target.isDefending ? base * 2 : base;
  }

  /** ±5% jitter per §15.1. Math.random is fine for slice scope. */
  function damageJitter() {
    return 0.95 + Math.random() * 0.10;
  }
  const RESOLVE_DELAY_MS = 600;
  const BAND_PERFORMANCE_RESOLVE_DELAY_MS = 1200;
  const ENEMY_TURN_DELAY_MS = 800;

  /** @type {THREE.Group | null} */
  let group = null;
  /** Team members fighting on the player's side. team[0] takes the
   * first turn each round, then team[1], etc.; KO'd members are
   * skipped. */
  /** @type {Character[]} */
  let team = [];
  /** Index into `team` of whoever's turn it currently is. */
  let activeTeamIdx = 0;
  /**
   * Alias for the currently-active team member. Reassigned by
   * `setActive()` so the existing action handlers can keep saying
   * `player.X` without caring how many members are in the band.
   * @type {Character | null}
   */
  let player = null;
  /** Number of team-member turns that have happened in the current
   * round; the enemy goes once `actedThisRound` reaches the alive
   * count. Reset by `startRound()`. */
  let actedThisRound = 0;
  /** @type {Character | null} */
  let enemy = null;
  /** @type {BattlePhase} */
  let phase = 'playerTurn';
  let hype = 0;
  /** @type {(() => void)[]} */
  let unsubs = [];
  /** @type {ReturnType<typeof setTimeout>[]} */
  let timers = [];

  /** @type {ReturnType<typeof startRhythm> | null} */
  let rhythm = null;
  /** Time (ms, performance.now-relative) when the current rhythm round started. */
  let rhythmStartMs = 0;
  /** True for the duration of a Band Performance round; affects damage and Hype on resolve. */
  let isBandPerformance = false;

  function emitHp(/** @type {'player'|'enemy'} */ side) {
    const c = side === 'player' ? player : enemy;
    if (!c) return;
    eventBus.emit('battle.hpChanged', { side, id: c.id, hp: c.hp, hpMax: c.hpMax });
  }

  /**
   * Per-team-member HP dispatch. Used when an attack lands on a
   * specific member (not necessarily the active one), e.g. an enemy
   * targeting a defender on the back line.
   *
   * @param {Character} c
   */
  function emitMemberHp(c) {
    if (!c) return;
    const side = c === enemy ? 'enemy' : 'team';
    eventBus.emit('battle.hpChanged', { side, id: c.id, hp: c.hp, hpMax: c.hpMax });
  }

  function emitHype() {
    eventBus.emit('battle.hypeChanged', { value: hype, max: HYPE_MAX });
  }

  /** @param {string} text */
  function setPrompt(text) {
    eventBus.emit('battle.promptChanged', { text });
  }

  /** @param {() => void} fn @param {number} ms */
  function delay(fn, ms) {
    const t = setTimeout(fn, ms);
    timers.push(t);
  }

  /**
   * §25.3 / §11 victory rewards.
   *   Notes  : 50 + 20·rank + rarityBonus           (§25.3)
   *   EXP    : (10 + 6·rank) × rarityMult × 0.5     (§11.2; ÷ band size = 1 in slice;
   *                                                   ×0.5 = main.json managerExpRatio)
   *   Cred   : 1 / 2 / 4 / 8 by rarity              (slice direct grant; full game
   *                                                   levels Cred from EXP via
   *                                                   §11.1 expToNextCred(cred))
   *
   * Both EXP and the direct Cred grant ship — EXP shows progress
   * over time while Cred continues to gate shop tiers immediately,
   * which keeps demo pacing snappy.
   *
   * @param {{ rank?: number, rarity?: string }} def
   */
  function grantVictoryRewards(def) {
    const rank = def.rank ?? 1;
    const rarityNotes = { common: 0, rare: 100, epic: 300, legendary: 1000 };
    const rarityCred = { common: 1, rare: 2, epic: 4, legendary: 8 };
    const rarityMult = { common: 1.0, rare: 1.2, epic: 1.5, legendary: 2.0 };
    const r = /** @type {keyof typeof rarityNotes} */ (def.rarity ?? 'common');
    const notes = 50 + 20 * rank + (rarityNotes[r] ?? 0);
    const cred = rarityCred[r] ?? 1;
    const exp = Math.round((10 + 6 * rank) * (rarityMult[r] ?? 1) * 0.5);
    dispatch({ type: 'GRANT_NOTES', amount: notes });
    dispatch({ type: 'GRANT_CREDIBILITY', amount: cred });
    dispatch({ type: 'GRANT_EXP', amount: exp });

    // §11.2 band exp — each alive member earns the post-rarity payout
    // (no ÷ band size; awarding per-member keeps low-rank progression
    // visible at slice scope). Loop the exp ladder so a big legendary
    // win can vault a rookie multiple ranks at once.
    const memberExp = Math.round((10 + 6 * rank) * (rarityMult[r] ?? 1));
    /** @type {{ id: string, name: string, fromRank: number, toRank: number }[]} */
    const levelUps = [];
    for (const c of team) {
      if (c.isKO) continue;
      const rosterId = c.id.split(':')[1] ?? c.id;
      const before = getState().roster[rosterId];
      if (!before) continue;
      dispatch({ type: 'GRANT_RIVAL_EXP', id: rosterId, amount: memberExp });
      const after = getState().roster[rosterId];
      if (!after) continue;
      let steps = 0;
      let pending = after.exp;
      let rk = after.rank;
      while (rk < 100 && pending >= expToNextRank(rk)) {
        pending -= expToNextRank(rk);
        rk++;
        steps++;
      }
      if (steps > 0) {
        const fromRank = before.rank;
        const toRank = fromRank + steps;
        // LEVEL_UP_RIVAL zeros exp; the rollover remainder is
        // intentionally dropped — slice progression is gentle enough
        // that overshoot is rare.
        dispatch({ type: 'LEVEL_UP_RIVAL', id: rosterId, ranks: steps });
        levelUps.push({ id: rosterId, name: before.name, fromRank, toRank });
        eventBus.emit('rival.leveledUp', {
          id: rosterId,
          name: before.name,
          fromRank,
          toRank,
        });
      }
    }

    // §25.4 item drop — chance scales with rival rarity. The pool is
    // weighted toward cheaper consumables for common rivals so the
    // player builds a stockpile early; epic/legendary win can land any
    // item (including Confidence Badge, the rare full-heal).
    const drop = rollItemDrop(r);

    eventBus.emit('battle.rewardsGranted', { notes, cred, exp, rank, rarity: r, drop });
    return { notes, cred, exp, levelUps, drop };
  }

  /**
   * Roll a post-battle item drop. Returns the granted item def + count
   * for prompt display, or null on no-drop.
   *
   * @param {string} rarity
   * @returns {{ itemId: string, name: string, count: number } | null}
   */
  function rollItemDrop(rarity) {
    const dropChance = { common: 0.30, rare: 0.55, epic: 0.80, legendary: 1.0 };
    const chance = dropChance[/** @type {keyof typeof dropChance} */ (rarity)] ?? 0.30;
    if (Math.random() >= chance) return null;

    /** @type {Record<string, any>} */
    let items;
    try {
      items = /** @type {Record<string, any>} */ (getConfig('items'));
    } catch {
      return null;
    }
    // Tier the pool by buy price so common drops favour the cheap pool.
    const ids = Object.keys(items);
    if (ids.length === 0) return null;
    const sorted = ids.slice().sort(
      (a, b) => (items[a].buy ?? 0) - (items[b].buy ?? 0)
    );
    const cheapCount = Math.max(1, Math.ceil(sorted.length / 2));
    const cheapPool = sorted.slice(0, cheapCount);
    const fullPool = sorted;
    const pool =
      rarity === 'common'
        ? cheapPool
        : rarity === 'rare'
          ? sorted.slice(0, Math.max(cheapCount, sorted.length - 1))
          : fullPool;
    const itemId = pool[Math.floor(Math.random() * pool.length)];
    if (!itemId) return null;
    // Legendary occasionally drops a pair.
    const count = rarity === 'legendary' && Math.random() < 0.4 ? 2 : 1;
    dispatch({ type: 'GRANT_ITEM', itemId, count });
    return { itemId, name: items[itemId]?.name ?? itemId, count };
  }

  /**
   * Whether the player has the option to recruit the just-defeated
   * rival. False if no template, or the template is already in the
   * roster (avoids duplicate prompts).
   *
   * @param {{ templateId?: string }} def
   */
  function canOfferRecruit(def) {
    if (!def?.templateId) return false;
    return !getState().capturedRivals.includes(def.templateId);
  }

  /**
   * Player accepted the post-victory prompt — capture the rival
   * unconditionally. The §24 random roll is replaced with player
   * choice: every defeat is a recruit opportunity, no luck involved.
   *
   * @param {{ templateId: string, name: string, role: string,
   *           rarity: string, rank: number }} def
   */
  function recruitDefeated(def) {
    dispatch({
      type: 'RECRUIT_RIVAL',
      templateId: def.templateId,
      name: def.name,
      role: def.role,
      rarity: def.rarity,
      rank: def.rank,
    });
    eventBus.emit('battle.rivalRecruited', {
      templateId: def.templateId,
      name: def.name,
      rank: def.rank,
      rarity: def.rarity,
    });
  }

  function checkVictory() {
    if (!enemy || team.length === 0) return false;
    if (enemy.isKO) {
      phase = 'gameOver';
      const rewards = grantVictoryRewards(currentRivalDef ?? {});
      const line = currentRivalDef?.victoryLine ?? '';
      const rewardText = ` · +${rewards.notes} N · +${rewards.exp} EXP · +${rewards.cred} Cred`;
      const dropText = rewards.drop
        ? ` · Got ${rewards.drop.name}${rewards.drop.count > 1 ? ` ×${rewards.drop.count}` : ''}!`
        : '';
      const lineText = line ? `${enemy.name}: "${line}"` : 'Victory!';
      const levelUpText = rewards.levelUps.length
        ? ' · ' +
          rewards.levelUps
            .map((l) =>
              l.toRank - l.fromRank > 1
                ? `${l.name} → rank ${l.toRank} (+${l.toRank - l.fromRank})`
                : `${l.name} → rank ${l.toRank}`
            )
            .join(', ')
        : '';
      // Capture-the-rival prompt: if eligible, ask the player to
      // commit. Otherwise just nudge them to leave.
      const canRecruit = canOfferRecruit(currentRivalDef ?? {});
      const tail = canRecruit
        ? ` · Y to recruit ${currentRivalDef?.name ?? 'them'} · N/Esc to skip`
        : ' · Press Esc to continue.';
      setPrompt(`${lineText}${rewardText}${levelUpText}${dropText}${tail}`);
      shakeCamera(0.65, 480);
      freezeFor(220);
      eventBus.emit('battle.gameOver', { outcome: 'victory' });
      return true;
    }
    if (isTeamWiped()) {
      phase = 'gameOver';
      const line = currentRivalDef?.defeatLine ?? '';
      setPrompt(line ? `${enemy.name}: "${line}" · Press Esc to continue.` : 'Defeated. Press Esc to return.');
      shakeCamera(0.55, 420);
      freezeFor(220);
      eventBus.emit('battle.gameOver', { outcome: 'defeat' });
      return true;
    }
    return false;
  }

  function startPlayerTurn() {
    phase = 'playerTurn';
    if (player) player.isDefending = false;
    const itemHint = inventoryHasAny() ? ' · I = Items' : '';
    const who = player?.name ?? 'Your';
    const lead = team.length > 1 ? `${who}'s turn` : 'Your turn';
    if (hype >= HYPE_MAX) {
      setPrompt(
        `${lead} — Z = Strum · X = Perform · V = BAND PERFORMANCE! · C = Defend${itemHint}`
      );
    } else {
      setPrompt(`${lead} — Z = Strum · X = Perform · C = Defend${itemHint}`);
    }
  }

  function inventoryHasAny() {
    const inv = getState().inventory;
    return Object.values(inv).some((c) => c > 0);
  }

  function openItemMenu() {
    if (!player) return;
    const inv = getState().inventory;
    let items;
    try {
      items = /** @type {Record<string, any>} */ (getConfig('items'));
    } catch (e) {
      console.error('battleScene: items config missing', e);
      return;
    }
    const entries = Object.entries(inv)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => {
        const def = items[id];
        return {
          id,
          name: def?.name ?? id,
          summary: def?.summary ?? '',
          count,
        };
      });
    if (entries.length === 0) return;

    phase = 'itemMenu';
    setPrompt('Choose an item to use…');
    itemMenu.show(
      entries,
      (itemId) => useItem(itemId),
      () => {
        // Cancelled — return to the action menu.
        startPlayerTurn();
      }
    );
  }

  /** @param {string} itemId */
  function useItem(itemId) {
    if (!player) return;
    let items;
    try {
      items = /** @type {Record<string, any>} */ (getConfig('items'));
    } catch {
      return;
    }
    const def = items[itemId];
    if (!def) return;

    dispatch({ type: 'CONSUME_ITEM', itemId });

    let resultText = '';
    const eff = def.effect;
    if (eff?.kind === 'heal' && eff.stat === 'confidence') {
      const amount = Math.round(player.hpMax * (eff.amountPctOfMax ?? 0));
      const { before, after } = player.heal(amount);
      emitHp('player');
      resultText = `${player.name} restores ${after - before} Confidence.`;
    } else if (eff?.kind === 'heal' && eff.stat === 'energy') {
      // Energy/MP isn't gameplay-active in the slice; the buff is
      // applied to data faithfully and noted for the player.
      const amount = Math.round(player.mpMax * (eff.amountPctOfMax ?? 0));
      player.mp = Math.min(player.mpMax, player.mp + amount);
      resultText = `${player.name} regains ${amount} Energy.`;
    } else if (eff?.kind === 'buff') {
      const stat = eff.stat;
      const mult = eff.mult ?? 1;
      player.statBuffs[stat] = (player.statBuffs[stat] ?? 1) * mult;
      const pct = Math.round((mult - 1) * 100);
      resultText = `${player.name}'s ${stat} ${pct >= 0 ? '+' : ''}${pct}% for the rest of battle.`;
    } else {
      resultText = `${def.name} used.`;
    }

    phase = 'resolving';
    setPrompt(resultText);
    delay(() => {
      // After an item, the actor's turn is over. Advance through the
      // round (next alive team member) or fire the enemy turn if
      // everyone has acted.
      nextActor();
    }, ENEMY_TURN_DELAY_MS - 200);
  }

  /**
   * Strum — the basic, always-available attack. No rhythm minigame,
   * no Energy cost; in fact it *restores* a little Energy so the
   * player can recover from running dry on Performs. Damage uses the
   * same §15.1 chain as a Perform but with a smaller basePower and
   * no accuracy/critical multipliers — equivalent to a Perform at
   * the 50–79 % accuracy band, ~30 % the punch of a clean Neon Riff.
   *
   * Manager-Style modifiers still apply (Coach's damageMult, etc.) so
   * builds remain coherent. Strum's small Hype trickle keeps Band
   * Performance reachable even on a low-Perform play.
   */
  function performStrum() {
    if (!player || !enemy) return;
    phase = 'resolving';

    const fx = getState().manager.style?.effects ?? {};
    const grooveBuff = player.statBuffs.groove ?? 1;
    const scaleStat = player.stats.groove * grooveBuff;
    const statusBuffMult = fx.damageMult ?? 1;

    const rawDamage =
      (STRUM_BASE_POWER * scaleStat * statusBuffMult * damageJitter()) /
      confidenceDefense(enemy);
    const damage = Math.max(1, Math.round(rawDamage));

    // Energy regen — round up so the player always sees a non-zero
    // refund even at low Energy max. Capped at the pool ceiling.
    const regen = Math.max(1, Math.ceil(player.mpMax * STRUM_ENERGY_REGEN_PCT));
    const before = player.mp;
    player.mp = Math.min(player.mpMax, player.mp + regen);
    const gained = player.mp - before;

    player.playAttack();
    enemy.takeDamage(damage);
    emitHp('enemy');
    eventBus.emit('battle.damageDealt', {
      from: player.id,
      to: enemy.id,
      amount: damage,
    });

    const hypeGain = Math.round(STRUM_HYPE_GAIN * (fx.hypeGainMult ?? 1));
    hype = Math.min(HYPE_MAX, hype + hypeGain);
    emitHype();

    const energyText = gained > 0 ? ` · +${gained} Energy` : '';
    setPrompt(
      `${player.name} strums — ${damage} dmg · +${hypeGain} Hype${energyText}`
    );

    delay(() => {
      nextActor();
    }, STRUM_DELAY_MS);
  }

  function performDefend() {
    if (!player || !enemy) return;
    phase = 'resolving';
    player.isDefending = true;

    hype = Math.min(HYPE_MAX, hype + DEFEND_HYPE_GAIN);
    emitHype();
    setPrompt(`${player.name} braces for the next strike. +${DEFEND_HYPE_GAIN} Hype.`);

    delay(() => {
      nextActor();
    }, DEFEND_DELAY_MS);
  }

  /** Active song for the in-flight rhythm round. */
  /** @type {any} */
  let currentSong = null;

  /** Active rival template (intro / victory / defeat lines). */
  /** @type {any} */
  let currentRivalDef = null;

  function pickRivalDef() {
    let roster;
    try {
      roster = /** @type {Record<string, any>} */ (getConfig('rivals'));
    } catch (e) {
      console.error('battleScene: rivals config missing', e);
      // Fallback so the slice never hard-fails.
      return {
        id: 'rival',
        name: 'Rival',
        role: 'guitarist',
        rarity: 'common',
        rank: 1,
        color: '0xe85a5a',
        stats: { technicality: 11, focus: 12, groove: 13, confidence: 11, creativity: 8, energy: 13 },
        intro: '',
        victoryLine: 'You took the slot. Take care of it.',
        defeatLine: 'Better luck on your next gig.',
      };
    }
    const ids = Object.keys(roster);
    const id = ids[Math.floor(Math.random() * ids.length)];
    return roster[id];
  }

  /** §7.2 rarity multipliers. */
  function rarityMultiplierFor(/** @type {string} */ rarity) {
    switch (rarity) {
      case 'rare':
        return 1.2;
      case 'epic':
        return 1.5;
      case 'legendary':
        return 2.0;
      case 'common':
      default:
        return 1.0;
    }
  }

  /**
   * §9.3 role-specific stat growth per rank. Rivals start from
   * rivals.json baseline (rank 1) and grow by these per rank. Used
   * when the encounter rolls a rank > 1 — common islands stay near
   * 1, rare islands push into double digits.
   *
   * @type {Record<string, Record<string, number>>}
   */
  const ROLE_STAT_GROWTH = {
    guitarist:   { technicality: 1.4, focus: 1.0, groove: 1.8, confidence: 1.6, creativity: 1.3, energy: 1.2 },
    bassist:     { technicality: 1.1, focus: 1.0, groove: 1.6, confidence: 2.2, creativity: 1.0, energy: 1.2 },
    drummer:     { technicality: 1.2, focus: 1.5, groove: 1.6, confidence: 1.8, creativity: 0.9, energy: 1.7 },
    keyboardist: { technicality: 1.6, focus: 1.0, groove: 0.9, confidence: 1.5, creativity: 1.9, energy: 1.6 },
    singer:      { technicality: 1.0, focus: 1.1, groove: 1.0, confidence: 2.0, creativity: 1.7, energy: 1.4 },
  };

  /**
   * §9.2 rank-1 baselines for the player's roles. Mirrors the rivals
   * baseline numbers in rivals.json — same growth table, same source
   * truth.
   *
   * @type {Record<string, Record<string, number>>}
   */
  const ROLE_BASE_STATS = {
    guitarist:   { technicality: 12, focus: 10, groove: 14, confidence: 9,  creativity: 11, energy: 10 },
    bassist:     { technicality: 10, focus: 9,  groove: 13, confidence: 13, creativity: 9,  energy: 10 },
    drummer:     { technicality: 11, focus: 12, groove: 13, confidence: 11, creativity: 8,  energy: 13 },
    keyboardist: { technicality: 13, focus: 9,  groove: 8,  confidence: 9,  creativity: 14, energy: 12 },
    singer:      { technicality: 9,  focus: 10, groove: 9,  confidence: 12, creativity: 13, energy: 11 },
  };

  const ROLE_COLORS = {
    guitarist:   0x6ec1ff,
    bassist:     0xc77dff,
    drummer:     0xe0a050,
    keyboardist: 0x6ec1ff,
    singer:      0x5ce0a0,
  };

  /**
   * Build a Character from a roster entry — role gives baselines,
   * rank scales them via §9.3 growth, rarity multiplies on top.
   * Same compound formula used for rivals so a captured Riff Lord
   * fights with the same stat profile as a wild Riff Lord of the
   * same rank.
   *
   * @param {import('../engine/gameState.js').RosterMember} m
   * @param {string} id  unique id for the in-battle Character (avoids
   *                     colliding with the rival's id when the team
   *                     and enemy share a templateId)
   */
  function createTeamCharacter(m, id) {
    const role = ROLE_BASE_STATS[m.role] ? m.role : 'guitarist';
    const baseStats = ROLE_BASE_STATS[role];
    const rarityMult = rarityMultiplierFor(m.rarity);
    const stats = scaleStatsForRival(baseStats, role, m.rank, rarityMult);
    const hpMax = Math.round(
      (100 + (m.rank - 1) * 15) * rarityMult + stats.confidence * 2
    );
    const mpMax = Math.round(
      (50 + (m.rank - 1) * 5) * rarityMult + stats.energy * 1.5
    );
    return new Character({
      id,
      name: m.name,
      isPlayer: true,
      stats,
      hpMax,
      mpMax,
      color: ROLE_COLORS[/** @type {keyof typeof ROLE_COLORS} */ (role)] ?? 0x6ec1ff,
    });
  }

  /**
   * Reassign the `player` alias to whichever team member is now
   * acting. Re-emits a charactersChanged so the HUD's badges update
   * to the new active member.
   *
   * @param {number} idx
   */
  function setActive(idx) {
    activeTeamIdx = idx;
    player = team[idx] ?? null;
    if (!player) return;
    const m = teamRosterFor(player.id);
    eventBus.emit('battle.activeChanged', {
      id: player.id,
      name: player.name,
      role: m?.role ?? 'guitarist',
      rank: m?.rank ?? 1,
      rarity: m?.rarity ?? 'common',
    });
  }

  /**
   * Lookup the roster member that produced a given in-battle id.
   * Ids are minted as `t<index>:<rosterId>` so we can recover the
   * source roster entry for HUD decoration without bleeding extra
   * fields into the Character class.
   *
   * @param {string} id
   */
  function teamRosterFor(id) {
    const rosterId = id.split(':')[1] ?? id;
    return getState().roster[rosterId];
  }

  function isTeamWiped() {
    if (team.length === 0) return true;
    return team.every((c) => c.isKO);
  }

  /** Round-robin: starting from `from`, return the next alive idx. */
  function nextAliveTeamIdx(from) {
    if (team.length === 0) return -1;
    for (let i = 0; i < team.length; i++) {
      const idx = (from + i) % team.length;
      if (!team[idx].isKO) return idx;
    }
    return -1;
  }

  /**
   * Enemy aggro: defenders draw the hit. Otherwise random alive
   * member. Returns null only if the team is wiped, which is checked
   * separately for victory state.
   */
  function pickEnemyTarget() {
    const alive = team.filter((c) => !c.isKO);
    if (alive.length === 0) return null;
    const defender = alive.find((c) => c.isDefending);
    if (defender) return defender;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  /**
   * Begin a fresh round of player turns. Reset the per-round
   * counter, jump to the first alive member, fire startPlayerTurn.
   */
  function startRound() {
    actedThisRound = 0;
    const idx = nextAliveTeamIdx(0);
    if (idx < 0) return;
    setActive(idx);
    startPlayerTurn();
  }

  /**
   * Called after a player action resolves. If more team members
   * still have to act this round, advance to the next alive one.
   * Otherwise the enemy gets its turn.
   */
  function nextActor() {
    if (checkVictory()) return;
    actedThisRound += 1;
    const aliveCount = team.filter((c) => !c.isKO).length;
    if (actedThisRound >= aliveCount) {
      startEnemyTurn();
      return;
    }
    const idx = nextAliveTeamIdx(activeTeamIdx + 1);
    if (idx < 0) {
      startEnemyTurn();
      return;
    }
    setActive(idx);
    startPlayerTurn();
  }

  /**
   * Scale a rival's rank-1 stats out to the encounter-rolled rank
   * and apply the rarity multiplier on top, per §9.1's compound
   * formula:
   *   stat = round((base + growth × (rank − 1)) × rarityMult)
   *
   * @param {Record<string, number>} stats
   * @param {string} role
   * @param {number} rank
   * @param {number} rarityMult
   */
  function scaleStatsForRival(stats, role, rank, rarityMult) {
    const growth = ROLE_STAT_GROWTH[role] ?? ROLE_STAT_GROWTH.guitarist;
    /** @type {Record<string, number>} */
    const out = {};
    for (const [key, base] of Object.entries(stats)) {
      const g = growth[key] ?? 1.0;
      out[key] = Math.round((base + g * (rank - 1)) * rarityMult);
    }
    return /** @type {any} */ (out);
  }

  function openSongMenu() {
    if (!player) return;
    const songs = /** @type {Record<string, any>} */ (getConfig('songs'));
    const entries = Object.values(songs)
      .filter(/** @param {any} s */ (s) => s.type !== 'band_performance')
      .map(/** @param {any} s */ (s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        power: s.power,
        scalesOff: s.scalesOff,
        energy: s.energy,
        affordable: player.mp >= s.energy,
      }));
    phase = 'songMenu';
    setPrompt('Pick a song to perform…');
    songMenu.show(
      entries,
      { mp: player.mp, mpMax: player.mpMax },
      (songId) => startPerformWithSong(songId, false),
      () => startPlayerTurn()
    );
  }

  /**
   * @param {string} songId
   * @param {boolean} bandPerformance
   */
  function startPerformWithSong(songId, bandPerformance) {
    if (!player || !enemy) return;
    const songs = /** @type {Record<string, any>} */ (getConfig('songs'));
    const pattern = songs[songId];
    if (!pattern) {
      console.error(`battleScene: songs.${songId} pattern missing`);
      return;
    }
    if (!bandPerformance && player.mp < pattern.energy) {
      // Shouldn't happen via the menu — defensive log only.
      console.warn(`battleScene: insufficient Energy for ${songId}`);
      startPlayerTurn();
      return;
    }

    if (!bandPerformance) {
      player.mp = Math.max(0, player.mp - pattern.energy);
    }

    phase = 'performing';
    isBandPerformance = bandPerformance;
    currentSong = pattern;
    setPrompt(
      bandPerformance
        ? `BAND PERFORMANCE — ${pattern.name} — get ready: D F J K`
        : `${pattern.name} — get ready: D F J K`
    );

    if (bandPerformance) {
      eventBus.emit('battle.bandPerformanceStarted', { songId, name: pattern.name });
    }

    // Lead-in: shift the song clock forward so the first ~1.8s
    // returns negative time. The engine's spawn-lookahead is 1.2s, so
    // the lane stays visually empty until ~600ms before the first
    // note hits — long enough for the player to place fingers on
    // D F J K. The "GET READY" banner spans the lead-in.
    const RHYTHM_LEAD_IN_MS = 1800;
    rhythmStartMs = performance.now() + RHYTHM_LEAD_IN_MS;

    // Technicality widens the Perfect window per §1.3. Rank 1 stats
    // sit in the 9-13 band with median 11, so we baseline against 11
    // rather than 5 and add 2 ms per point above.
    const tech = player.stats.technicality;
    const perfectWindowBonusMs = (tech - 11) * 2;
    const critWindowBonusMs = Math.max(0, Math.floor((tech - 11) * 1));
    rhythm = startRhythm(
      pattern,
      () => (performance.now() - rhythmStartMs) / 1000,
      { perfectWindowBonusMs, critWindowBonusMs }
    );
    rhythmUI.show(rhythm.getLiveNotes, rhythm.getCurrentTime, {
      bandPerformance: bandPerformance,
    });
    rhythmUI.flashReady(RHYTHM_LEAD_IN_MS);
  }

  /** @param {boolean} bandPerformance */
  function startPerform(bandPerformance) {
    if (bandPerformance) {
      startPerformWithSong('finalEncore', true);
    } else {
      openSongMenu();
    }
  }

  function resolvePerform() {
    if (!player || !enemy || !rhythm) return;
    const result = rhythm.getResult();
    const bp = isBandPerformance;

    rhythm.stop();
    rhythm = null;
    rhythmUI.hide();
    isBandPerformance = false;
    currentSong = null;

    phase = 'resolving';

    // §15.1 full damage formula. Components missing from the slice
    // (equipmentBonus, rarityMultiplier) default to 1.0 — they slot in
    // unchanged when those systems land.
    const fx = getState().manager.style?.effects ?? {};

    // scaleStat — pick the stat named in song.scalesOff per §15. "mixed"
    // averages Groove and Creativity (Final Encore). Visionary's
    // creativityStatMult and item buffs stack per §21.4.
    const scalesOff = currentSong?.scalesOff ?? 'creativity';
    const baseStat = (() => {
      if (scalesOff === 'mixed') {
        return (player.stats.groove + player.stats.creativity) / 2;
      }
      return player.stats[scalesOff] ?? player.stats.creativity;
    })();
    const styleStatMult = scalesOff === 'creativity' ? (fx.creativityStatMult ?? 1) : 1;
    const buffMult = player.statBuffs[scalesOff] ?? 1;
    const scaleStat = baseStat * styleStatMult * buffMult;

    // accuracyMultiplier from §14.3 table; criticalMultiplier from §22
    // is 1.5x on 100% accuracy, 1.0x otherwise.
    const accMult = accuracyMultiplier(result.accuracy);
    const critMult = result.flawless ? 1.5 : 1.0;

    // statusBuffMultiplier — Coach's damageMult (0.9) plus any future
    // status buffs/debuffs. Showrunner's BP bonus is applied below
    // separately per §16.1 framing.
    let statusBuffMult = fx.damageMult ?? 1;
    if (bp) statusBuffMult *= fx.bandPerformanceDamageMult ?? 1;

    const songPower = currentSong?.power ?? 1.0;
    const isHeal = currentSong?.type === 'heal';
    // Heal songs target the band's own confidence (no defense divisor)
    // per §16.4.1; attack/debuff/BP songs target the rival's defense.
    const defense = isHeal ? 1 : confidenceDefense(enemy);

    const rawDamage =
      (songPower *
        scaleStat *
        accMult *
        critMult *
        statusBuffMult *
        damageJitter()) /
      defense;
    const damage = Math.max(1, Math.round(rawDamage));

    player.playAttack();
    if (isHeal) {
      const { before, after } = player.heal(damage);
      emitHp('player');
      eventBus.emit('battle.healed', {
        from: player.id,
        to: player.id,
        amount: after - before,
      });
    } else {
      enemy.takeDamage(damage);
      emitHp('enemy');
      eventBus.emit('battle.damageDealt', {
        from: player.id,
        to: enemy.id,
        amount: damage,
        bandPerformance: bp,
      });
    }

    let hypeGain;
    if (bp) {
      hype = 0;
      hypeGain = -HYPE_MAX;
    } else {
      // Showrunner: +25% Hype gain.
      const rawHype = (PERFORM_BASE_HYPE + result.accuracy * PERFORM_ACCURACY_HYPE) *
        (fx.hypeGainMult ?? 1);
      hypeGain = Math.round(rawHype);
      hype = Math.min(HYPE_MAX, hype + hypeGain);
    }
    emitHype();

    if (bp) {
      eventBus.emit('battle.bandPerformanceEnded', {
        accuracy: result.accuracy,
        totalDamage: damage,
        flawless: result.flawless,
      });
    }

    const grade = result.flawless
      ? 'FLAWLESS'
      : result.accuracy >= 0.8
        ? 'GREAT'
        : result.accuracy >= 0.5
          ? 'GOOD'
          : 'ROUGH';
    const hypeText = bp ? 'Hype consumed' : `+${hypeGain} Hype`;
    const prefix = bp ? 'ENCORE! ' : '';
    const critText = result.criticals > 0 ? ` · ${result.criticals} bull's-eye` : '';
    const streakText = result.maxStreak >= 3 ? ` · max streak ${result.maxStreak}` : '';
    const effectText = isHeal ? `+${damage} Confidence` : `${damage} dmg`;
    setPrompt(
      `${prefix}${grade} — ${result.perfect}P/${result.good}G/${result.okay}O/${result.miss}M${critText} · ${effectText} · ${hypeText}${streakText}`
    );

    delay(
      () => {
        nextActor();
      },
      bp ? BAND_PERFORMANCE_RESOLVE_DELAY_MS : RESOLVE_DELAY_MS
    );
  }

  function startEnemyTurn() {
    if (!enemy) return;
    phase = 'enemyTurn';
    setPrompt(`${enemy.name} is winding up…`);

    delay(() => {
      if (!enemy) return;
      const target = pickEnemyTarget();
      if (!target) {
        // Whole team's already KO'd somehow — bail to victory check.
        checkVictory();
        return;
      }
      // §15.1 formula simplified for the rival (no rhythm minigame
      // for them, so accuracy is fixed at the 50-79% band ~1.2x).
      const rawDmg =
        (ENEMY_PERFORM_POWER * enemy.stats.groove * 1.2 * damageJitter()) /
        confidenceDefense(target);
      const dmg = Math.max(1, Math.round(rawDmg));
      enemy.playAttack();
      target.takeDamage(dmg);
      emitMemberHp(target);
      eventBus.emit('battle.damageDealt', { from: enemy.id, to: target.id, amount: dmg });
      // Defend consumes its protection on the hit it absorbed.
      target.isDefending = false;

      if (checkVictory()) return;
      startRound();
    }, ENEMY_TURN_DELAY_MS);
  }

  return {
    id: 'battle',

    enter(ctx) {
      group = new THREE.Group();

      // Build the team from state. Each roster id in `state.team`
      // produces one Character; missing ids fall back to a
      // guitarist-baseline rank-1 placeholder so the battle scene is
      // never empty (e.g. saves that predate the team feature).
      team = [];
      const s = getState();
      const ids = s.team.length > 0 ? s.team : ['starter'];
      ids.forEach((rid, i) => {
        const member = s.roster[rid] ?? {
          id: rid,
          templateId: rid,
          name: 'You',
          role: 'guitarist',
          rarity: 'common',
          rank: 1,
          exp: 0,
          capturedAt: new Date().toISOString(),
        };
        team.push(createTeamCharacter(member, `t${i}:${rid}`));
      });
      // Fan the team across the X-axis line so each silhouette
      // reads from the iso angle without overlap.
      const n = team.length;
      team.forEach((c, i) => {
        const z = (i - (n - 1) / 2) * 0.9;
        c.setBasePosition(-2.5, 0.8, z);
        group.add(c.mesh);
      });
      setActive(0);

      // Pull a random rival template (name / role / color / lines)
      // from the roster, then override rank + rarity from the
      // encounter the explore scene rolled. Higher-tier islands have
      // higher rankRange in encounters.json, so a rival caught at
      // Open Arena hits noticeably harder than one at Garage Stage.
      const rivalDef = pickRivalDef();
      const pending = getState().world?.pendingEncounter ?? null;
      const finalRarity = pending?.rarity ?? rivalDef.rarity ?? 'common';
      const finalRank = pending?.rank ?? rivalDef.rank ?? 1;
      // templateId is the rivals.json key; recruitment uses it to
      // dedupe captures across battles.
      currentRivalDef = {
        ...rivalDef,
        templateId: rivalDef.id,
        rank: finalRank,
        rarity: finalRarity,
      };

      const rarityMult = rarityMultiplierFor(finalRarity);
      const scaledStats = scaleStatsForRival(
        rivalDef.stats,
        rivalDef.role,
        finalRank,
        rarityMult
      );
      // §10 HP / Energy formulas use the SCALED confidence/energy so
      // ranks compound correctly: HP and the conf stat both grow.
      const hpMax = Math.round(
        (100 + (finalRank - 1) * 15) * rarityMult + scaledStats.confidence * 2
      );
      const mpMax = Math.round(
        (50 + (finalRank - 1) * 5) * rarityMult + scaledStats.energy * 1.5
      );
      enemy = new Character({
        id: 'e1',
        name: rivalDef.name,
        isPlayer: false,
        stats: scaledStats,
        hpMax,
        mpMax,
        color: parseInt(rivalDef.color, 16),
      });
      enemy.setBasePosition(2, 0.8, 0);
      group.add(enemy.mesh);

      ctx.scene.add(group);

      hype = 0;
      phase = 'introducing';
      battleHud.show();
      battleFx.show();
      // Build the team payload from the in-battle Characters +
      // their source roster entries (for role/rank/rarity badges).
      const teamPayload = team.map((c) => {
        const m = teamRosterFor(c.id);
        return {
          id: c.id,
          name: c.name,
          hp: c.hp,
          hpMax: c.hpMax,
          role: m?.role ?? 'guitarist',
          rank: m?.rank ?? 1,
          rarity: m?.rarity ?? 'common',
        };
      });
      const activeId = team[activeTeamIdx]?.id ?? null;
      eventBus.emit('battle.charactersChanged', {
        team: teamPayload,
        activeId,
        // Backward-compat single-player slot — still populated so
        // any HUD that hasn't migrated still has data to show.
        player: teamPayload[activeTeamIdx] ?? teamPayload[0],
        enemy: {
          id: enemy.id,
          name: enemy.name,
          hp: enemy.hp,
          hpMax: enemy.hpMax,
          role: rivalDef.role,
          rank: finalRank,
          rarity: finalRarity,
        },
      });
      const activeStyle = getState().manager.style;
      // Splash carries the role+rank+rarity decoration; HUD has its
      // own badges so the in-fight readout reinforces what the
      // splash announced.
      const enemyLabel = `${enemy.name} (Rk ${finalRank} · ${finalRarity})`;
      eventBus.emit('battle.encounterStarted', {
        encounterName: 'JAM CLASH!',
        playerName: player.name,
        enemyName: enemyLabel,
        styleName: activeStyle?.name ?? '',
      });
      emitHype();
      setPrompt('');

      // Damage feedback — hit-pause + shake scaled by hit size and
      // whether it was a Band Performance climax. Subscribed inside the
      // scene's lifecycle so it auto-cleans on exit.
      unsubs.push(
        eventBus.on(
          'battle.damageDealt',
          /** @param {{ amount: number, bandPerformance?: boolean }} p */
          (p) => {
            if (!p) return;
            if (p.bandPerformance) {
              shakeCamera(0.45, 380);
              freezeFor(140);
            } else if (p.amount >= 50) {
              shakeCamera(0.28, 260);
              freezeFor(90);
            } else {
              shakeCamera(0.16, 200);
              freezeFor(60);
            }
          }
        )
      );

      unsubs.push(
        eventBus.on(
          'input.keyDown',
          /**
           * @param {{ code: string, shiftKey?: boolean }} payload
           */
          (payload) => {
            if (!payload) return;

            // Debug shortcuts — held Shift unlocks them so they don't
            // trigger by accident during rhythm play. Ship-build will
            // gate these behind a build flag; harmless during the
            // hackathon since judges aren't holding Shift.
            if (payload.shiftKey && phase === 'playerTurn' && payload.code === 'KeyH') {
              hype = HYPE_MAX;
              emitHype();
              setPrompt('[debug] Hype filled — V = BAND PERFORMANCE!');
              return;
            }
            if (payload.shiftKey && phase === 'playerTurn' && payload.code === 'KeyK' && enemy) {
              enemy.takeDamage(enemy.hp);
              emitHp('enemy');
              checkVictory();
              return;
            }

            if (payload.code === 'Escape') {
              if (rhythm) {
                rhythm.stop();
                rhythm = null;
                rhythmUI.hide();
              }
              // After a battle the player usually wants to manage
              // their tour — visit the shop, switch islands, check
              // owned roster. Drop them at the world map; from there
              // they can step right back into Explore on the same
              // island in one keypress.
              sceneManager.transition('worldMap');
              return;
            }
            // Victory recruit prompt: Y captures, N is an explicit
            // skip (same effect as Esc except it stays in battle so
            // the player can read the dialogue).
            if (
              phase === 'gameOver' &&
              currentRivalDef &&
              canOfferRecruit(currentRivalDef) &&
              payload.code === 'KeyY'
            ) {
              recruitDefeated({
                templateId: currentRivalDef.templateId,
                name: currentRivalDef.name,
                role: currentRivalDef.role ?? 'guitarist',
                rarity: currentRivalDef.rarity ?? 'common',
                rank: currentRivalDef.rank ?? 1,
              });
              setPrompt(
                `${currentRivalDef.name} JOINED YOUR ROSTER! · Press Esc to return.`
              );
              return;
            }
            if (
              phase === 'gameOver' &&
              currentRivalDef &&
              canOfferRecruit(currentRivalDef) &&
              payload.code === 'KeyN'
            ) {
              setPrompt(
                `${currentRivalDef.name} walked off into the night… · Press Esc to return.`
              );
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyZ') {
              performStrum();
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyX') {
              startPerform(false);
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyV' && hype >= HYPE_MAX) {
              startPerform(true);
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyC') {
              performDefend();
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyI') {
              openItemMenu();
              return;
            }
            if (phase === 'itemMenu') {
              itemMenu.handleKey(payload.code);
              return;
            }
            if (phase === 'songMenu') {
              songMenu.handleKey(payload.code);
              return;
            }
            if (phase === 'performing' && rhythm && LANE_KEYS.includes(payload.code)) {
              rhythm.onKeyDown(payload.code);
            }
          }
        )
      );

      // Hold input briefly so the JAM CLASH! telegraph lands before
      // the player can act. Matches the splash duration in battleFx.
      delay(() => {
        if (phase === 'introducing') startRound();
      }, 1100);
    },

    update(dt) {
      // Idle bob / attack lunge / KO collapse animations run every
      // frame regardless of phase so characters always feel alive.
      for (const c of team) c.update(dt);
      enemy?.update(dt);

      if (phase !== 'performing' || !rhythm) return;
      rhythm.tick();
      rhythmUI.update();
      if (rhythm.isComplete()) {
        resolvePerform();
      }
    },

    exit() {
      for (const u of unsubs) u();
      unsubs = [];
      for (const t of timers) clearTimeout(t);
      timers = [];

      if (rhythm) {
        rhythm.stop();
        rhythm = null;
      }
      rhythmUI.hide();
      battleHud.hide();
      battleFx.hide();
      itemMenu.hide();
      songMenu.hide();
      resetTimeFx();
      for (const c of team) c.clearBuffs();
      enemy?.clearBuffs();

      if (group?.parent) group.parent.remove(group);
      group = null;
      team = [];
      activeTeamIdx = 0;
      actedThisRound = 0;
      player = null;
      enemy = null;
      currentSong = null;
      currentRivalDef = null;
      hype = 0;
      phase = 'playerTurn';
      isBandPerformance = false;

      // Consume the encounter so the next battle gets a freshly
      // rolled rank/rarity from whichever island the player walks on.
      dispatch({ type: 'CLEAR_PENDING_ENCOUNTER' });
    },
  };
})();
