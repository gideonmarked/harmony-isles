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
    const assetKey = `sprites.characters.${rawKey.split(':').pop()}`;

    if (assetLoader.hasManifestEntry(assetKey)) {
      // Real sprite registered — render as a billboarded plane and
      // load the texture asynchronously. The plane keeps its
      // facing-the-camera orientation through the orthographic-iso
      // view, so a 2D sprite reads correctly on the 3D stage. The
      // material uses transparency so PNGs with alpha don't render
      // a black square while loading.
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        side: THREE.DoubleSide,
      });
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.6), material);
      this.mesh.position.y = 0.8;
      assetLoader.loadTexture(assetKey).then((tex) => {
        material.map = tex;
        material.needsUpdate = true;
      });
    } else {
      // No manifest entry — keep the colored placeholder cuboid so
      // the slice still renders something obvious. (The magenta-bbox
      // fallback only kicks in for *registered* ids whose files fail
      // to load, per §27.9.)
      this.mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 1.6, 0.4),
        new THREE.MeshStandardMaterial({
          color: init.color ?? (init.isPlayer ? 0x6ec1ff : 0xe85a5a),
        })
      );
      this.mesh.position.y = 0.8;
    }

    /** Rest position the animation system perturbs around. */
    this.basePosition = { x: 0, y: 0.8, z: 0 };

    /** Phase offset so multiple characters don't bob in lockstep. */
    this.idleTime = Math.random() * Math.PI * 2;

    /** Counts down from ATTACK_DURATION_MS during a lunge. */
    this.attackTimer = 0;

    /** Counts up to KO_DURATION_S after KO triggers. */
    this.koTimer = 0;

    /** True between defending and the next incoming hit. Halves damage. */
    this.isDefending = false;

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

  /** Trigger the attack-lunge animation. */
  playAttack() {
    this.attackTimer = ATTACK_DURATION_MS;
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

    if (this.isKO) {
      this.koTimer = Math.min(KO_DURATION_S, this.koTimer + dt);
      const k = this.koTimer / KO_DURATION_S;
      this.mesh.rotation.z = (-Math.PI / 2) * k * (this.isPlayer ? 1 : -1);
      this.mesh.position.set(
        this.basePosition.x + attackX,
        this.basePosition.y - KO_DROP * k,
        this.basePosition.z
      );
      return;
    }

    this.mesh.rotation.z = 0;
    const idleY = Math.sin(this.idleTime * IDLE_FREQ) * IDLE_AMPLITUDE;
    this.mesh.position.set(
      this.basePosition.x + attackX,
      this.basePosition.y + idleY,
      this.basePosition.z
    );
  }

  get isKO() {
    return this.hp === 0;
  }
}
