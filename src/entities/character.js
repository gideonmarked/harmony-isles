// @ts-check

import * as THREE from 'three';

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
 */

/**
 * Battle participant. Owns the gameplay state (HP/MP, stats) and a
 * placeholder Three.js mesh that real Aseprite sprites swap in for
 * later.
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

    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 1.6, 0.4),
      new THREE.MeshStandardMaterial({
        color: init.color ?? (init.isPlayer ? 0x6ec1ff : 0xe85a5a),
      })
    );
    this.mesh.position.y = 0.8;
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

  get isKO() {
    return this.hp === 0;
  }
}
