// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { startRhythm, LANE_KEYS } from '../engine/rhythmEngine.js';
import { freezeFor, shakeCamera, resetTimeFx } from '../engine/timeFx.js';
import { Character } from '../entities/character.js';
import { battleHud } from '../ui/battleHud.js';
import { battleFx } from '../ui/battleFx.js';
import { rhythmUI } from '../ui/rhythmUI.js';

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
  /** @typedef {'introducing' | 'playerTurn' | 'performing' | 'resolving' | 'enemyTurn' | 'gameOver'} BattlePhase */

  const HYPE_MAX = 100;
  const PERFORM_BASE_DAMAGE = 20;
  const PERFORM_ACCURACY_DAMAGE = 60;
  const PERFORM_CRIT_DAMAGE = 5;
  const PERFORM_BASE_HYPE = 15;
  const PERFORM_ACCURACY_HYPE = 25;
  const BAND_PERFORMANCE_DAMAGE_MULT = 2.0;
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
    if (hype >= HYPE_MAX) {
      setPrompt('Your turn — Z = Perform · X = BAND PERFORMANCE!');
    } else {
      setPrompt('Your turn — press Z to perform Final Encore.');
    }
  }

  /** @param {boolean} bandPerformance */
  function startPerform(bandPerformance) {
    if (!player || !enemy) return;
    const songs = getConfig('songs');
    const songId = bandPerformance ? 'encoreFinale' : 'encore';
    const pattern = songs[songId];
    if (!pattern) {
      console.error(`battleScene: songs.${songId} pattern missing`);
      return;
    }

    phase = 'performing';
    isBandPerformance = bandPerformance;
    setPrompt(
      bandPerformance ? 'BAND PERFORMANCE! — D F J K' : 'Hit the lanes — D F J K'
    );

    if (bandPerformance) {
      eventBus.emit('battle.bandPerformanceStarted', { songId, name: pattern.name });
    }

    rhythmStartMs = performance.now();
    // Technicality widens the Perfect window per design doc §1.3.
    // Baseline is stat 5; each point above adds 3 ms, each point
    // below tightens by 3 ms (clamped to non-negative inside the
    // engine via Math.max with the good window).
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

  function resolvePerform() {
    if (!player || !enemy || !rhythm) return;
    const result = rhythm.getResult();
    const bp = isBandPerformance;

    rhythm.stop();
    rhythm = null;
    rhythmUI.hide();
    isBandPerformance = false;

    phase = 'resolving';

    // Creativity scales skill-style perform damage per design doc
    // §1.3 / §15. Baseline at stat 5 is 1.0x; each point above adds
    // 5 %, each point below subtracts 5 % (floored at 0.5x so a very
    // unfocused character can still chip).
    const creativityMult = Math.max(0.5, 1 + (player.stats.creativity - 5) * 0.05);
    const baseDamage =
      (PERFORM_BASE_DAMAGE +
        result.accuracy * PERFORM_ACCURACY_DAMAGE +
        result.criticals * PERFORM_CRIT_DAMAGE) *
      creativityMult;
    const damage = Math.round(bp ? baseDamage * BAND_PERFORMANCE_DAMAGE_MULT : baseDamage);
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
      hypeGain = Math.round(PERFORM_BASE_HYPE + result.accuracy * PERFORM_ACCURACY_HYPE);
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
      const dmg =
        ENEMY_PERFORM_DAMAGE.min +
        Math.floor(Math.random() * (ENEMY_PERFORM_DAMAGE.max - ENEMY_PERFORM_DAMAGE.min + 1));
      enemy.playAttack();
      player.takeDamage(dmg);
      emitHp('player');
      eventBus.emit('battle.damageDealt', { from: enemy.id, to: player.id, amount: dmg });

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
      eventBus.emit('battle.encounterStarted', {
        encounterName: 'JAM CLASH!',
        playerName: player.name,
        enemyName: enemy.name,
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
      resetTimeFx();

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
