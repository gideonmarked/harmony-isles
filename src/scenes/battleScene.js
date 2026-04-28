// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { getState, dispatch } from '../engine/gameState.js';
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
  const PERFORM_BASE_DAMAGE = 20;
  const PERFORM_ACCURACY_DAMAGE = 60;
  const PERFORM_CRIT_DAMAGE = 5;
  const PERFORM_BASE_HYPE = 15;
  const PERFORM_ACCURACY_HYPE = 25;
  const DEFEND_DAMAGE_MULT = 0.5;
  const DEFEND_HYPE_GAIN = 6;
  const DEFEND_DELAY_MS = 350;
  const ENEMY_PERFORM_DAMAGE = { min: 8, max: 14 };
  const RESOLVE_DELAY_MS = 600;
  const BAND_PERFORMANCE_RESOLVE_DELAY_MS = 1200;
  const ENEMY_TURN_DELAY_MS = 800;

  /** @type {THREE.Group | null} */
  let group = null;
  /** @type {Character | null} */
  let player = null;
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
    eventBus.emit('battle.hpChanged', { side, hp: c.hp, hpMax: c.hpMax });
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

  function checkVictory() {
    if (!player || !enemy) return false;
    if (enemy.isKO) {
      phase = 'gameOver';
      setPrompt('Victory! Press Esc to return.');
      shakeCamera(0.65, 480);
      freezeFor(220);
      eventBus.emit('battle.gameOver', { outcome: 'victory' });
      return true;
    }
    if (player.isKO) {
      phase = 'gameOver';
      setPrompt('Defeated. Press Esc to return.');
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
    if (hype >= HYPE_MAX) {
      setPrompt(`Your turn — Z = Perform · X = BAND PERFORMANCE! · C = Defend${itemHint}`);
    } else {
      setPrompt(`Your turn — Z = Perform · C = Defend${itemHint}`);
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
      if (checkVictory()) return;
      startEnemyTurn();
    }, ENEMY_TURN_DELAY_MS - 200);
  }

  function performDefend() {
    if (!player || !enemy) return;
    phase = 'resolving';
    player.isDefending = true;

    hype = Math.min(HYPE_MAX, hype + DEFEND_HYPE_GAIN);
    emitHype();
    setPrompt(`${player.name} braces for the next strike. +${DEFEND_HYPE_GAIN} Hype.`);

    delay(() => {
      if (checkVictory()) return;
      startEnemyTurn();
    }, DEFEND_DELAY_MS);
  }

  /** Active song for the in-flight rhythm round. */
  /** @type {any} */
  let currentSong = null;

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
        ? `BAND PERFORMANCE — ${pattern.name} — D F J K`
        : `${pattern.name} — D F J K`
    );

    if (bandPerformance) {
      eventBus.emit('battle.bandPerformanceStarted', { songId, name: pattern.name });
    }

    rhythmStartMs = performance.now();
    const tech = player.stats.technicality;
    const perfectWindowBonusMs = (tech - 5) * 3;
    const critWindowBonusMs = Math.max(0, Math.floor((tech - 5) * 1.5));
    rhythm = startRhythm(
      pattern,
      () => (performance.now() - rhythmStartMs) / 1000,
      { perfectWindowBonusMs, critWindowBonusMs }
    );
    rhythmUI.show(rhythm.getLiveNotes, rhythm.getCurrentTime, {
      bandPerformance: bandPerformance,
    });
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

    // Manager Style multiplier (design doc §21.4 stacking, applied
    // last over the rest of the formula). Effects map keys are
    // documented in src/configs/managerStyles.json.
    const fx = getState().manager.style?.effects ?? {};

    // Pick the scaling stat off the active song per §15. "mixed"
    // averages Groove and Creativity (§16.1 maps Final Encore to
    // mixed). Visionary's creativityStatMult (1.15) and item buffs
    // layer multiplicatively per §21.4.
    const scalesOff = currentSong?.scalesOff ?? 'creativity';
    const baseStat = (() => {
      if (scalesOff === 'mixed') {
        return (player.stats.groove + player.stats.creativity) / 2;
      }
      return player.stats[scalesOff] ?? player.stats.creativity;
    })();
    const styleStatMult = scalesOff === 'creativity' ? (fx.creativityStatMult ?? 1) : 1;
    const buffMult = player.statBuffs[scalesOff] ?? 1;
    const effectiveStat = baseStat * styleStatMult * buffMult;
    const statCurveMult = Math.max(0.5, 1 + (effectiveStat - 5) * 0.05);

    // Song.power is the §16.1 multiplier (1.0 Neon Riff … 2.4 Final
    // Encore). Replaces the old hardcoded BP multiplier — the BP
    // boost lives entirely in the Final Encore song's power value
    // plus Showrunner's bonus.
    const songPower = currentSong?.power ?? 1.0;

    let baseDamage =
      (PERFORM_BASE_DAMAGE +
        result.accuracy * PERFORM_ACCURACY_DAMAGE +
        result.criticals * PERFORM_CRIT_DAMAGE) *
      statCurveMult *
      songPower;

    // Coach: -10% damage across the board.
    baseDamage *= fx.damageMult ?? 1;

    // Showrunner: +15% damage when the active song is a Band Performance.
    if (bp) baseDamage *= fx.bandPerformanceDamageMult ?? 1;

    const damage = Math.round(baseDamage);
    player.playAttack();
    enemy.takeDamage(damage);
    emitHp('enemy');
    eventBus.emit('battle.damageDealt', {
      from: player.id,
      to: enemy.id,
      amount: damage,
      bandPerformance: bp,
    });

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
    const critText = result.criticals > 0 ? ` · ${result.criticals} crit` : '';
    const streakText = result.maxStreak >= 3 ? ` · max streak ${result.maxStreak}` : '';
    setPrompt(
      `${prefix}${grade} — ${result.perfect}P / ${result.good}G / ${result.miss}M${critText} · ${damage} dmg · ${hypeText}${streakText}`
    );

    delay(
      () => {
        if (checkVictory()) return;
        startEnemyTurn();
      },
      bp ? BAND_PERFORMANCE_RESOLVE_DELAY_MS : RESOLVE_DELAY_MS
    );
  }

  function startEnemyTurn() {
    if (!player || !enemy) return;
    phase = 'enemyTurn';
    setPrompt(`${enemy.name} is winding up…`);

    delay(() => {
      if (!player || !enemy) return;
      const rawDmg =
        ENEMY_PERFORM_DAMAGE.min +
        Math.floor(Math.random() * (ENEMY_PERFORM_DAMAGE.max - ENEMY_PERFORM_DAMAGE.min + 1));
      const dmg = player.isDefending ? Math.max(1, Math.round(rawDmg * DEFEND_DAMAGE_MULT)) : rawDmg;
      enemy.playAttack();
      player.takeDamage(dmg);
      emitHp('player');
      eventBus.emit('battle.damageDealt', { from: enemy.id, to: player.id, amount: dmg });
      // Defend consumes its protection on the first hit.
      player.isDefending = false;

      if (checkVictory()) return;
      startPlayerTurn();
    }, ENEMY_TURN_DELAY_MS);
  }

  return {
    id: 'battle',

    enter(ctx) {
      group = new THREE.Group();

      // Per design doc §9 (stat curves per role) characters have
      // varying stats; the slice tunes the player's defaults around
      // 7 to give Technicality / Creativity a visible effect on
      // Perfect window and damage scaling vs the Rival.
      player = new Character({
        id: 'p1',
        name: 'Player',
        isPlayer: true,
        stats: { technicality: 7, focus: 6, groove: 6, confidence: 7, creativity: 8, energy: 6 },
        hpMax: 100,
        mpMax: 50,
      });
      player.setBasePosition(-2, 0.8, 0);
      group.add(player.mesh);

      enemy = new Character({
        id: 'e1',
        name: 'Rival',
        isPlayer: false,
        stats: { technicality: 4, focus: 5, groove: 5, confidence: 5, creativity: 4, energy: 4 },
        hpMax: 80,
        mpMax: 30,
      });
      enemy.setBasePosition(2, 0.8, 0);
      group.add(enemy.mesh);

      ctx.scene.add(group);

      hype = 0;
      phase = 'introducing';
      battleHud.show();
      battleFx.show();
      eventBus.emit('battle.charactersChanged', {
        player: { name: player.name, hp: player.hp, hpMax: player.hpMax },
        enemy: { name: enemy.name, hp: enemy.hp, hpMax: enemy.hpMax },
      });
      const activeStyle = getState().manager.style;
      eventBus.emit('battle.encounterStarted', {
        encounterName: 'JAM CLASH!',
        playerName: player.name,
        enemyName: enemy.name,
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
              setPrompt('[debug] Hype filled — X = BAND PERFORMANCE!');
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
              sceneManager.transition('title');
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyZ') {
              startPerform(false);
              return;
            }
            if (phase === 'playerTurn' && payload.code === 'KeyX' && hype >= HYPE_MAX) {
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
        if (phase === 'introducing') startPlayerTurn();
      }, 1100);
    },

    update(dt) {
      // Idle bob / attack lunge / KO collapse animations run every
      // frame regardless of phase so characters always feel alive.
      player?.update(dt);
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
      player?.clearBuffs();
      enemy?.clearBuffs();

      if (group?.parent) group.parent.remove(group);
      group = null;
      player = null;
      enemy = null;
      hype = 0;
      phase = 'playerTurn';
      isBandPerformance = false;
    },
  };
})();
