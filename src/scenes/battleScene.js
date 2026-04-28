// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { startRhythm, LANE_KEYS } from '../engine/rhythmEngine.js';
import { Character } from '../entities/character.js';
import { battleHud } from '../ui/battleHud.js';
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
  /** @typedef {'playerTurn' | 'performing' | 'resolving' | 'enemyTurn' | 'gameOver'} BattlePhase */

  const HYPE_MAX = 100;
  const PERFORM_BASE_DAMAGE = 20;
  const PERFORM_ACCURACY_DAMAGE = 60;
  const PERFORM_BASE_HYPE = 15;
  const PERFORM_ACCURACY_HYPE = 25;
  const ENEMY_PERFORM_DAMAGE = { min: 8, max: 14 };
  const RESOLVE_DELAY_MS = 600;
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
      return true;
    }
    if (player.isKO) {
      phase = 'gameOver';
      setPrompt('Defeated. Press Esc to return.');
      return true;
    }
    return false;
  }

  function startPlayerTurn() {
    phase = 'playerTurn';
    setPrompt('Your turn — press Z to perform Final Encore.');
  }

  function startPerform() {
    if (!player || !enemy) return;
    const songs = getConfig('songs');
    const pattern = songs.encore;
    if (!pattern) {
      console.error('battleScene: songs.encore pattern missing');
      return;
    }

    phase = 'performing';
    setPrompt('Hit the lanes — D F J K');

    rhythmStartMs = performance.now();
    rhythm = startRhythm(pattern, () => (performance.now() - rhythmStartMs) / 1000);
    rhythmUI.show(rhythm.getLiveNotes, rhythm.getCurrentTime);
  }

  function resolvePerform() {
    if (!player || !enemy || !rhythm) return;
    const result = rhythm.getResult();

    rhythm.stop();
    rhythm = null;
    rhythmUI.hide();

    phase = 'resolving';

    const damage = Math.round(
      PERFORM_BASE_DAMAGE + result.accuracy * PERFORM_ACCURACY_DAMAGE
    );
    enemy.takeDamage(damage);
    emitHp('enemy');
    eventBus.emit('battle.damageDealt', {
      from: player.id,
      to: enemy.id,
      amount: damage,
    });

    const hypeGain = Math.round(
      PERFORM_BASE_HYPE + result.accuracy * PERFORM_ACCURACY_HYPE
    );
    hype = Math.min(HYPE_MAX, hype + hypeGain);
    emitHype();

    const grade =
      result.flawless
        ? 'FLAWLESS'
        : result.accuracy >= 0.8
          ? 'GREAT'
          : result.accuracy >= 0.5
            ? 'GOOD'
            : 'ROUGH';
    setPrompt(
      `${grade} — ${result.perfect}P / ${result.good}G / ${result.miss}M · ${damage} dmg · +${hypeGain} Hype`
    );

    delay(() => {
      if (checkVictory()) return;
      startEnemyTurn();
    }, RESOLVE_DELAY_MS);
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

      player = new Character({
        id: 'p1',
        name: 'Player',
        isPlayer: true,
        stats: { technicality: 5, focus: 5, groove: 5, confidence: 5, creativity: 5, energy: 5 },
        hpMax: 100,
        mpMax: 50,
      });
      player.mesh.position.set(-2, 0.8, 0);
      group.add(player.mesh);

      enemy = new Character({
        id: 'e1',
        name: 'Rival',
        isPlayer: false,
        stats: { technicality: 4, focus: 4, groove: 4, confidence: 4, creativity: 4, energy: 4 },
        hpMax: 80,
        mpMax: 30,
      });
      enemy.mesh.position.set(2, 0.8, 0);
      group.add(enemy.mesh);

      ctx.scene.add(group);

      hype = 0;
      battleHud.show();
      eventBus.emit('battle.charactersChanged', {
        player: { name: player.name, hp: player.hp, hpMax: player.hpMax },
        enemy: { name: enemy.name, hp: enemy.hp, hpMax: enemy.hpMax },
      });
      emitHype();

      unsubs.push(
        eventBus.on(
          'input.keyDown',
          /** @param {{ code: string }} payload */
          (payload) => {
            if (!payload) return;
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
              startPerform();
              return;
            }
            if (phase === 'performing' && rhythm && LANE_KEYS.includes(payload.code)) {
              rhythm.onKeyDown(payload.code);
            }
          }
        )
      );

      startPlayerTurn();
    },

    update() {
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

      if (group?.parent) group.parent.remove(group);
      group = null;
      player = null;
      enemy = null;
      hype = 0;
      phase = 'playerTurn';
    },
  };
})();
