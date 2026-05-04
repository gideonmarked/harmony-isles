// @ts-check

import * as THREE from 'three';

import { assetLoader } from '../engine/assetLoader.js';

/**
 * @typedef {object} CharacterStats
 * @property {number} technicality   widens the rhythm 'perfect' window
 * @property {number} focus          turn speed + dodge chance
 * @property {number} groove         scales physical-style perform damage
 * @property {number} confidence     battle stamina pool (HP)
 * @property {number} creativity     scales skill-style perform damage
 * @property {number} energy         resource consumed by song performs (MP)
 *
 * @typedef {object} CharacterInit
 * @property {string} id
 * @property {string} name
 * @property {boolean} isPlayer
 * @property {CharacterStats} stats
 * @property {number} hpMax
 * @property {number} mpMax
 * @property {THREE.ColorRepresentation} [color]   placeholder quad color
 * @property {string} [assetKey]                   override for asset manifest lookup;
 *                                                  defaults to id stripped of `tN:` /
 *                                                  `enemy:` prefix
 */

const IDLE_AMPLITUDE = 0.05;
const IDLE_FREQ = 2.4;
const ATTACK_DURATION_MS = 380;
const ATTACK_LUNGE = 0.9;
const KO_DURATION_S = 0.42;
const KO_DROP = 0.55;

/**
 * Sprite size in world units. PNGs are 124×124 (square). The ground
 * offset places the sprite's bottom edge on y=0, which is what
 * battleScene assumes when it picks anchor positions.
 */
const SPRITE_SIZE = 2.4;
export const SPRITE_GROUND_OFFSET = SPRITE_SIZE / 2;

/**
 * Per-state framerate. The exporter ships ~9 frames per anim, so 6 fps
 * for idle reads as a slow breathing loop and 12 fps for action states
 * lands them inside the lunge window without looking choppy.
 */
const ANIM_FPS = { idle: 6, ready: 8, strum: 12, perform: 12 };

/**
 * Folder used when a character's own id has no sprite directory yet
 * (e.g. the unrecruited starter, or a rival we haven't drawn art
 * for). Picked because guitarist art reads broadly enough to stand in
 * for any role at a glance. Adjust here if you want a different
 * stand-in.
 */
const DEFAULT_CHARACTER_ASSET_KEY = 'riffLord';

/**
 * Battle participant. Owns the gameplay state (HP/MP, stats), a
 * placeholder Three.js mesh that real Aseprite sprites swap in for,
 * and a small animation state machine (idle bob, attack lunge, KO
 * collapse) per design doc §28-29.
 */
export class Character {
  /** @param {CharacterInit} init */
  constructor(init) {
    this.id = init.id;
    this.name = init.name;
    this.isPlayer = init.isPlayer;
    this.stats = init.stats;
    this.hpMax = init.hpMax;
    this.hp = init.hpMax;
    this.mpMax = init.mpMax;
    this.mp = init.mpMax;

    // Asset lookup — strip the battle-id prefix (`t0:`, `enemy:`) so
    // the same key matches both the captured roster member and a
    // freshly-spawned enemy of the same template.
    const rawKey = init.assetKey ?? init.id;
    this.charKey = rawKey.split(':').pop() ?? rawKey;

    // Render as a Three.js Sprite — a built-in billboard that always
    // faces the camera with no shear. PlaneGeometry shears under the
    // iso camera (the quad's normal isn't aligned with view), which
    // made characters look tipped. Sprites stay axis-aligned in
    // screen space, so the pre-rendered south-east art reads as flat
    // 2D regardless of camera pose.
    const fallbackColor = init.color ?? (init.isPlayer ? 0x6ec1ff : 0xe85a5a);
    const material = new THREE.SpriteMaterial({
      color: fallbackColor,
      transparent: true,
    });
    this.mesh = new THREE.Sprite(material);
    // Sprite scale doubles as size — there's no PlaneGeometry to set
    // dimensions on. Note: negative scale on Sprite does *not*
    // reliably mirror in Three.js (winding/cull edge case), so the
    // enemy mirror is done at the texture level — see #getDisplay().
    this.mesh.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1);
    this.mesh.position.y = SPRITE_GROUND_OFFSET;

    /**
     * Cache of mirror-UV-cloned textures keyed by their source. Only
     * populated for non-player characters; players go through the
     * source texture directly. WeakMap so unloaded source textures
     * release their mirrored siblings automatically.
     * @type {WeakMap<THREE.Texture, THREE.Texture>}
     */
    this.mirroredTextures = new WeakMap();

    /** @type {THREE.Texture | null} */
    this.defaultTex = null;
    /** @type {import('../engine/assetLoader.js').CharacterAnimSet | null} */
    this.charAnim = null;
    /** Active animation: 'idle' | 'ready' | 'strum' | 'perform' | 'ko'. */
    this.animState = 'idle';
    this.animFrame = 0;
    this.animTime = 0;

    // Resolution chain: try the character's own folder first, fall
    // back to the global default. Once anything loads, swap the
    // material from its placeholder color to white so the PNG renders
    // its true colors.
    const resolveSprite = async () => {
      let key = this.charKey;
      let def = await assetLoader.loadCharacterDefault(key);
      if (!def && key !== DEFAULT_CHARACTER_ASSET_KEY) {
        key = DEFAULT_CHARACTER_ASSET_KEY;
        def = await assetLoader.loadCharacterDefault(key);
      }
      if (!def) return; // No art at all — leave the colored quad in place.
      this.defaultTex = def;
      this.charKey = key;
      material.color.set(0xffffff);
      if (!material.map) this.#setMap(material, def);
      this.charAnim = await assetLoader.loadCharacterAnimations(key);
    };
    resolveSprite();

    /** Rest position the animation system perturbs around. */
    this.basePosition = { x: 0, y: SPRITE_GROUND_OFFSET, z: 0 };

    /** Phase offset so multiple characters don't bob in lockstep. */
    this.idleTime = Math.random() * Math.PI * 2;

    /** Counts down from ATTACK_DURATION_MS during a lunge. */
    this.attackTimer = 0;

    /** Counts up to KO_DURATION_S after KO triggers. */
    this.koTimer = 0;

    /** True between defending and the next incoming hit. Halves damage. */
    this.isDefending = false;

    /**
     * True while this character is the team's currently-acting member.
     * Drives the `ready` looping animation. battleScene flips this on
     * every team via {@link Character#setActive} when `setActive(idx)`
     * advances the queue.
     */
    this.isActive = false;

    /**
     * What the in-flight attack lunge represents. Kept on the instance
     * so `update()` can pick the matching animation for the duration
     * of the lunge timer rather than tracking it externally.
     * @type {'strum' | 'perform'}
     */
    this.attackKind = 'strum';

    /**
     * When set, the sprite stays on the named loop indefinitely
     * regardless of the lunge timer. battleScene flips this on at the
     * start of an action and off when the action resolves, so the
     * full Strum / Perform animation plays for the whole window
     * rather than just the brief lunge.
     * @type {'strum' | 'perform' | null}
     */
    this.actionLoop = null;

    /**
     * Multiplicative buffs from items / status effects, applied per
     * design doc §21.4 stacking rules. Reset between battles.
     * @type {Record<string, number>}
     */
    this.statBuffs = {
      technicality: 1,
      focus: 1,
      groove: 1,
      confidence: 1,
      creativity: 1,
      energy: 1,
    };
  }

  /** Reset all per-battle buffs. Call between battles or on scene exit. */
  clearBuffs() {
    this.statBuffs = {
      technicality: 1,
      focus: 1,
      groove: 1,
      confidence: 1,
      creativity: 1,
      energy: 1,
    };
  }

  /**
   * Heal HP up to the cap.
   *
   * @param {number} amount
   * @returns {{ before: number, after: number }}
   */
  heal(amount) {
    const before = this.hp;
    this.hp = Math.min(this.hpMax, this.hp + Math.max(0, Math.floor(amount)));
    return { before, after: this.hp };
  }

  /**
   * Set the character's rest position. The animation system perturbs
   * around this anchor each frame, so callers must use this rather
   * than writing `mesh.position` directly.
   *
   * @param {number} x @param {number} y @param {number} z
   */
  setBasePosition(x, y, z) {
    this.basePosition = { x, y, z };
    this.mesh.position.set(x, y, z);
  }

  /**
   * Apply damage. Floors any fractional damage and clamps at 0.
   *
   * @param {number} amount
   * @returns {{ before: number, after: number, ko: boolean }}
   */
  takeDamage(amount) {
    const before = this.hp;
    this.hp = Math.max(0, this.hp - Math.max(0, Math.floor(amount)));
    return { before, after: this.hp, ko: this.hp === 0 };
  }

  /**
   * Trigger the attack-lunge animation. `kind` selects which sprite
   * loop plays for the duration of the lunge — 'strum' for the basic
   * action, 'perform' for rhythm performs and Band Performance.
   *
   * @param {'strum' | 'perform'} [kind]
   */
  playAttack(kind = 'strum') {
    this.attackTimer = ATTACK_DURATION_MS;
    this.attackKind = kind;
  }

  /**
   * Mark this character as the actively-queued member. battleScene
   * flips one true and the rest false each time the turn advances;
   * `update()` picks `ready` over `idle` while the flag is set.
   *
   * @param {boolean} active
   */
  setActive(active) {
    this.isActive = !!active;
  }

  /**
   * Pin the sprite to a strum or perform loop until the action
   * resolves. Use this when an action lasts longer than the brief
   * lunge — e.g. the Perform rhythm minigame, which can run for
   * 10–30 s. battleScene calls `stopActionLoop()` when the action
   * ends and the priority chain falls back to ready/idle.
   *
   * @param {'strum' | 'perform'} kind
   */
  startActionLoop(kind) {
    if (this.actionLoop === kind) return;
    this.actionLoop = kind;
    this.animFrame = 0;
    this.animTime = 0;
  }

  /** Clear the loop set by {@link startActionLoop}. */
  stopActionLoop() {
    this.actionLoop = null;
  }

  /**
   * Advance idle / attack / KO animations. Call once per frame
   * regardless of phase so the bob keeps going during dialogue.
   *
   * @param {number} dt  Seconds since last frame.
   */
  update(dt) {
    this.idleTime += dt;

    let attackX = 0;
    if (this.attackTimer > 0) {
      this.attackTimer = Math.max(0, this.attackTimer - dt * 1000);
      const progress = 1 - this.attackTimer / ATTACK_DURATION_MS;
      attackX = Math.sin(progress * Math.PI) * ATTACK_LUNGE * (this.isPlayer ? 1 : -1);
    }

    this.#advanceSpriteFrame(dt);

    if (this.isKO) {
      this.koTimer = Math.min(KO_DURATION_S, this.koTimer + dt);
      const k = this.koTimer / KO_DURATION_S;
      // Sprite is locked camera-facing — in-plane rotation lives on
      // the material, not the Object3D, so the KO collapse rotates
      // the sprite as a 2D image rather than a 3D quad.
      const material = /** @type {THREE.SpriteMaterial} */ (
        /** @type {any} */ (this.mesh).material
      );
      material.rotation = (-Math.PI / 2) * k * (this.isPlayer ? 1 : -1);
      this.mesh.position.set(
        this.basePosition.x + attackX,
        this.basePosition.y - KO_DROP * k,
        this.basePosition.z
      );
      return;
    }

    const material = /** @type {THREE.SpriteMaterial} */ (
      /** @type {any} */ (this.mesh).material
    );
    material.rotation = 0;
    // Idle bob removed — frame-by-frame sprite art carries the
    // breathing motion already, and the extra Y bob clashed with it.
    this.mesh.position.set(
      this.basePosition.x + attackX,
      this.basePosition.y,
      this.basePosition.z
    );
  }

  get isKO() {
    return this.hp === 0;
  }

  /**
   * Pick the animation that matches the current battle state and step
   * the frame. Cuboid placeholders skip this entirely (no `charAnim`).
   *
   * Priority: KO > attack lunge > active-in-queue > idle. KO freezes
   * on `default.png` so the collapse rotation reads cleanly. When a
   * state has zero frames loaded (e.g. the artist hasn't drawn
   * `ready/` yet) we fall back to the default texture rather than
   * leaving the previous animation's frame stuck on screen.
   *
   * @param {number} dt
   */
  #advanceSpriteFrame(dt) {
    const material = /** @type {THREE.SpriteMaterial | undefined} */ (
      /** @type {any} */ (this.mesh).material
    );
    if (!material || !this.charAnim) return;

    let nextState;
    if (this.isKO) nextState = 'ko';
    else if (this.actionLoop) nextState = this.actionLoop;
    else if (this.attackTimer > 0) nextState = this.attackKind;
    else if (this.isActive) nextState = 'ready';
    else nextState = 'idle';

    if (nextState !== this.animState) {
      this.animState = nextState;
      this.animFrame = 0;
      this.animTime = 0;
    }

    if (nextState === 'ko') {
      this.#setMap(material, this.defaultTex);
      return;
    }

    const frames = this.charAnim[nextState];
    if (!frames || frames.length === 0) {
      this.#setMap(material, this.defaultTex);
      return;
    }

    const fps = ANIM_FPS[/** @type {keyof typeof ANIM_FPS} */ (nextState)] ?? 8;
    const frameDur = 1 / fps;
    this.animTime += dt;
    while (this.animTime >= frameDur) {
      this.animTime -= frameDur;
      this.animFrame = (this.animFrame + 1) % frames.length;
    }
    this.#setMap(material, frames[this.animFrame]);
  }

  /**
   * Swap material.map only when it actually changes — re-assigning
   * the same Texture still costs a uniform upload, so the guard
   * matters when an animation is paused on its first frame.
   *
   * @param {THREE.SpriteMaterial} material
   * @param {THREE.Texture | null} tex
   */
  #setMap(material, tex) {
    if (!tex) return;
    const display = this.isPlayer ? tex : this.#getMirrored(tex);
    if (material.map === display) return;
    material.map = display;
    material.needsUpdate = true;
  }

  /**
   * Return a horizontally-mirrored clone of `tex`. Negative scale on
   * Sprite isn't a reliable mirror in Three.js, so we mirror at the
   * texture sampler level (`repeat.x = -1`) instead. Clones share the
   * source image so this is cheap; the WeakMap keeps results around
   * for the character's lifetime without leaking after the source
   * texture is released.
   *
   * @param {THREE.Texture} tex
   * @returns {THREE.Texture}
   */
  #getMirrored(tex) {
    let m = this.mirroredTextures.get(tex);
    if (!m) {
      m = tex.clone();
      m.wrapS = THREE.RepeatWrapping;
      m.repeat.x = -1;
      m.offset.x = 1;
      m.needsUpdate = true;
      this.mirroredTextures.set(tex, m);
    }
    return m;
  }
}
