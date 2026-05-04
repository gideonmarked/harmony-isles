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
 * Visual: rendered as a `THREE.Sprite` (always camera-facing, no
 * shear) with directional sprite art under
 * `/assets/sprites/characters/manager/animations/{breathing|walking}/
 * {north|south|east|west}/frame_NNN.png`. Walking plays the
 * `walking` loop in the current facing direction; standing still
 * plays the slower `breathing` loop. The colored cube placeholder
 * shows for the brief window before the first frame loads.
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

/** Sprite display size in world units (square; PNGs are 120×120). */
const SPRITE_SIZE = 1.2;
/** Y offset that puts the sprite's bottom edge on the tile floor. */
const SPRITE_GROUND_OFFSET = SPRITE_SIZE / 2;

/** Per-state framerate for sprite frames. */
const ANIM_FPS = { breathing: 4, walking: 10 };
/** Number of frames per state — folder layout is fixed by the
 *  exporter so we hardcode counts and avoid runtime probing. */
const FRAME_COUNTS = { breathing: 4, walking: 6 };

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

/**
 * Map a step delta to a compass facing. Top-down camera: -Y screen
 * direction is "north". WASD ↔ N/W/S/E from the player's read.
 *
 * @param {number} dx @param {number} dy
 * @returns {'north'|'south'|'east'|'west' | null}
 */
function dirToFacing(dx, dy) {
  if (dy < 0) return 'north';
  if (dy > 0) return 'south';
  if (dx < 0) return 'west';
  if (dx > 0) return 'east';
  return null;
}

/** Shared TextureLoader — same instance across players in a session. */
const textureLoader = new THREE.TextureLoader();

/**
 * Load every frame of the manager sprite set up front. ~40 PNGs;
 * runs once per session because the result is cached at module scope.
 *
 * @returns {Record<'breathing'|'walking', Record<'north'|'south'|'east'|'west', THREE.Texture[]>>}
 */
let cachedManagerFrames = /** @type {any} */ (null);
function loadManagerFrames() {
  if (cachedManagerFrames) return cachedManagerFrames;
  /** @type {any} */
  const out = {};
  const states = /** @type {('breathing'|'walking')[]} */ (Object.keys(FRAME_COUNTS));
  const dirs = /** @type {('north'|'south'|'east'|'west')[]} */ (
    ['north', 'south', 'east', 'west']
  );
  for (const state of states) {
    out[state] = {};
    for (const dir of dirs) {
      /** @type {THREE.Texture[]} */
      const frames = [];
      for (let i = 0; i < FRAME_COUNTS[state]; i++) {
        const n = String(i).padStart(3, '0');
        const url = `/assets/sprites/characters/manager/animations/${state}/${dir}/frame_${n}.png`;
        const tex = textureLoader.load(url);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        frames.push(tex);
      }
      out[state][dir] = frames;
    }
  }
  cachedManagerFrames = out;
  return out;
}

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

    /** Current facing — survives between steps so an idle manager
     *  keeps looking the way they last walked. */
    this.facing = /** @type {'north'|'south'|'east'|'west'} */ ('south');
    /** Active animation set name. */
    this.animState = /** @type {'breathing'|'walking'} */ ('breathing');
    /** Frame index within the active set. */
    this.animFrame = 0;
    /** Time accumulator for advancing frames. */
    this.animTime = 0;

    // Sprite mesh — always camera-facing, no shear under the
    // top-down camera the explore scene uses.
    const material = new THREE.SpriteMaterial({
      color: 0xffffff,
      transparent: true,
    });
    this.mesh = new THREE.Sprite(material);
    this.mesh.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1);

    this.#frames = loadManagerFrames();
    // Prime the material map immediately so the first frame shows
    // before the texture image actually decodes.
    const first = this.#frames[this.animState][this.facing][0];
    if (first) {
      material.map = first;
      material.needsUpdate = true;
    }

    this.#snapMeshToTile();

    /** Subtle idle bob, scaled down so the silhouette stays grounded. */
    this.idleTime = Math.random() * Math.PI * 2;
  }

  /** @type {ReturnType<typeof loadManagerFrames>} */
  #frames;

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
    // Update facing on every attempt — bumping into a wall should
    // still turn the manager so the sprite reads the right way.
    const facing = dirToFacing(dx, dy);
    if (facing) this.facing = facing;
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
    } else {
      // Idle — any held or just-pressed key starts a step right away.
      const dir = this.#readDirection();
      if (dir) {
        this.tryStep(dir[0], dir[1]);
      }
      this.#updateMeshPosition();
    }

    this.#advanceAnimation(dt);
  }

  /**
   * Pick the right animation set for the player's state and step the
   * frame. Walking while moving, breathing when still. Switching sets
   * resets the frame so the new loop starts at frame 0 instead of
   * jumping mid-stride.
   *
   * @param {number} dt
   */
  #advanceAnimation(dt) {
    const nextState = this.stepProgress < 1 ? 'walking' : 'breathing';
    if (nextState !== this.animState) {
      this.animState = nextState;
      this.animFrame = 0;
      this.animTime = 0;
    }
    const frames = this.#frames[this.animState]?.[this.facing];
    if (!frames || frames.length === 0) return;
    const fps = ANIM_FPS[this.animState];
    const frameDur = 1 / fps;
    this.animTime += dt;
    while (this.animTime >= frameDur) {
      this.animTime -= frameDur;
      this.animFrame = (this.animFrame + 1) % frames.length;
    }
    const tex = frames[this.animFrame];
    const material = /** @type {THREE.SpriteMaterial} */ (
      /** @type {any} */ (this.mesh).material
    );
    if (tex && material.map !== tex) {
      material.map = tex;
      material.needsUpdate = true;
    }
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
    const w = this.island.tileToWorld(this.tileX, this.tileY, SPRITE_GROUND_OFFSET);
    this.mesh.position.set(w.x, w.y, w.z);
  }

  #updateMeshPosition() {
    const a = this.island.tileToWorld(this.prevTileX, this.prevTileY, SPRITE_GROUND_OFFSET);
    const b = this.island.tileToWorld(this.tileX, this.tileY, SPRITE_GROUND_OFFSET);
    const t = this.stepProgress;
    this.mesh.position.set(
      a.x + (b.x - a.x) * t,
      a.y,
      a.z + (b.z - a.z) * t
    );
  }
}
