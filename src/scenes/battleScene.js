// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { Character } from '../entities/character.js';
import { battleHud } from '../ui/battleHud.js';

/**
 * Battle scene — the Jam Clash arena. Spawns one player and one enemy,
 * runs a small turn-based state machine, and routes input through the
 * HUD prompt.
 *
 * The Perform action is currently a **stub**: pressing Z deals fixed
 * damage and gains Hype without playing the rhythm minigame. The real
 * rhythm engine replaces this stub in a follow-up commit. The state
 * machine, HUD wiring, KO resolution, and damage events are deliberately
 * shaped to match what the rhythm engine will need so the swap is local.
 *
 * State machine:
 *   playerTurn  → wait for Z, transition to performing
 *   performing  → resolve damage + Hype, transition to enemyTurn
 *   enemyTurn   → automated enemy strike, transition to playerTurn
 *   gameOver    → victory or defeat; Esc returns to title
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const battleScene = (() => {
  /** @typedef {'playerTurn' | 'performing' | 'enemyTurn' | 'gameOver'} BattlePhase */

  const HYPE_MAX = 100;
  const PLAYER_PERFORM_DAMAGE = { min: 12, max: 18 };
  const PLAYER_HYPE_GAIN = 20;
  const ENEMY_PERFORM_DAMAGE = { min: 8, max: 12 };
  const PERFORM_DELAY_MS = 400;
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
    setPrompt('Your turn — press Z to perform.');
  }

  function performStub() {
    if (!player || !enemy) return;
    phase = 'performing';
    setPrompt('Performing…');

    // Stub damage roll — replaced by rhythm-engine accuracy in next chunk.
    const dmg =
      PLAYER_PERFORM_DAMAGE.min +
      Math.floor(Math.random() * (PLAYER_PERFORM_DAMAGE.max - PLAYER_PERFORM_DAMAGE.min + 1));
    enemy.takeDamage(dmg);
    emitHp('enemy');
    eventBus.emit('battle.damageDealt', { from: player.id, to: enemy.id, amount: dmg });

    hype = Math.min(HYPE_MAX, hype + PLAYER_HYPE_GAIN);
    emitHype();

    delay(() => {
      if (checkVictory()) return;
      startEnemyTurn();
    }, PERFORM_DELAY_MS);
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
        hpMax: 60,
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
              sceneManager.transition('title');
              return;
            }
            if (payload.code === 'KeyZ' && phase === 'playerTurn') {
              performStub();
            }
          }
        )
      );

      startPlayerTurn();
    },

    exit() {
      for (const u of unsubs) u();
      unsubs = [];
      for (const t of timers) clearTimeout(t);
      timers = [];

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
