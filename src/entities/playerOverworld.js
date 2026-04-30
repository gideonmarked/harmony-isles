// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { inputManager } from '../engine/inputManager.js';

/**
 * Player on the overworld — grid-locked WASD / arrow movement.
 *
 * The player owns its tile coordinate (`tileX`, `tileY`); the mesh
 * lerps between the previous tile and the target tile during a step.
 * On step completion, emits `player.stepped` with the destination
 * tile so the encounter system can roll.
 *
 * Held-key behavior:
 *   The design doc §12.1 specifies a 200 ms hold-to-walk delay before
 *   auto-repeat. That delay is meant to disambiguate a tap from a
 *   hold — but a step itself already takes 200+ ms, so by the time
 *   the previous step finishes the player has obviously been holding
 *   if they didn't release. Adding another 200 ms warm-up between
 *   each step makes movement feel staggered. We drop the warm-up
 *   entirely and chain the next step the instant the previous one
 *   arrives, which is what every Pokémon / Final Fantasy overworld
 *   actually feels like.
 *
 * @typedef {object} PlayerOverworldInit
 * @property {import('../world/island.js').Island} island
 */

const STEP_DURATION_S = 0.18; // ~5.5 tiles/sec — snappier than the doc's 4 tiles/sec, still readable

const KEY_TO_DIR = /** @type {Record<string, [number, number]>} */ ({
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
});

export class PlayerOverworld {
  /** @param {PlayerOverworldInit} init */
  constructor(init) {
    this.island = init.island;
    [this.tileX, this.tileY] = init.island.spawnTile;

    /** Previous tile during interpolation. */
    this.prevTileX = this.tileX;
    this.prevTileY = this.tileY;
    /** 0 → still, 1 → arrived. Drives the lerp. */
    this.stepProgress = 1;

    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 1.0, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x6ec1ff })
    );
    this.#snapMeshToTile();

    /** Subtle idle bob, scaled down so the silhouette stays grounded. */
    this.idleTime = Math.random() * Math.PI * 2;
  }

  /**
   * Try to step in a direction (dx, dy). Rejects diagonal moves and
   * out-of-walkable destinations. Returns true if the step was
   * accepted (player entered the moving state).
   *
   * @param {number} dx @param {number} dy
   */
  tryStep(dx, dy) {
    if (this.stepProgress < 1) return false;
    if ((dx === 0) === (dy === 0)) return false; // both zero or both non-zero
    const tx = this.tileX + dx;
    const ty = this.tileY + dy;
    if (!this.island.isWalkable(tx, ty)) {
      eventBus.emit('player.bumped', { tileX: tx, tileY: ty });
      return false;
    }
    this.prevTileX = this.tileX;
    this.prevTileY = this.tileY;
    this.tileX = tx;
    this.tileY = ty;
    this.stepProgress = 0;
    return true;
  }

  /**
   * Drive movement. Reads held keys, advances any in-flight step,
   * and emits `player.stepped` on arrival.
   *
   * @param {number} dt  seconds since last frame
   */
  update(dt) {
    this.idleTime += dt;

    if (this.stepProgress < 1) {
      this.stepProgress = Math.min(1, this.stepProgress + dt / STEP_DURATION_S);
      this.#updateMeshPosition();
      if (this.stepProgress >= 1) {
        const tileType = this.island.tileTypeAt(this.tileX, this.tileY);
        eventBus.emit('player.stepped', {
          tileX: this.tileX,
          tileY: this.tileY,
          tileType,
        });
        // Chain — if a movement key is still held (or was tapped this
        // frame), kick off the next step immediately. No warm-up =
        // no stagger between consecutive tiles when walking.
        const chain = this.#readDirection();
        if (chain) {
          this.tryStep(chain[0], chain[1]);
          this.#updateMeshPosition();
        }
      }
      return;
    }

    // Idle — any held or just-pressed key starts a step right away.
    const dir = this.#readDirection();
    if (dir) {
      this.tryStep(dir[0], dir[1]);
    }
    this.#updateMeshPosition();
  }

  /**
   * Returns the highest-priority active direction this frame, or null.
   * Just-pressed wins over held so a tap mid-walk feels responsive
   * even if the player is also holding a different key.
   *
   * @returns {[number, number] | null}
   */
  #readDirection() {
    for (const code of Object.keys(KEY_TO_DIR)) {
      if (inputManager.wasPressed(code)) return KEY_TO_DIR[code];
    }
    for (const code of Object.keys(KEY_TO_DIR)) {
      if (inputManager.isHeld(code)) return KEY_TO_DIR[code];
    }
    return null;
  }

  #snapMeshToTile() {
    const w = this.island.tileToWorld(this.tileX, this.tileY, 0.5);
    this.mesh.position.set(w.x, w.y, w.z);
  }

  #updateMeshPosition() {
    const a = this.island.tileToWorld(this.prevTileX, this.prevTileY, 0.5);
    const b = this.island.tileToWorld(this.tileX, this.tileY, 0.5);
    const t = this.stepProgress;
    const bob = Math.sin(this.idleTime * 8) * 0.04 * (t < 1 ? 1 : 0.4);
    this.mesh.position.set(
      a.x + (b.x - a.x) * t,
      a.y + bob,
      a.z + (b.z - a.z) * t
    );
  }
}
