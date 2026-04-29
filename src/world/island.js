// @ts-check

import * as THREE from 'three';

import { getConfig } from '../engine/configService.js';

/**
 * Island — builds a tile grid into a Three.js Group and exposes
 * walkable / tile-type lookups for the explore scene.
 *
 * Tiles live on the XZ plane at integer coordinates. The island is
 * centered at world origin so the orthographic-iso camera frames it
 * naturally without per-island camera math.
 *
 * @typedef {object} IslandDef
 * @property {string} id
 * @property {string} name
 * @property {string} rarity
 * @property {string} biome
 * @property {string} encounterTable
 * @property {number} width
 * @property {number} height
 * @property {[number, number]} spawnTile
 * @property {string[]} tiles                row strings, length = width
 * @property {Record<string, string>} legend  glyph → tileType
 */

/**
 * Tile palette — kept small and readable. Real biome textures swap
 * in here when the asset pipeline lands (§27).
 */
const TILE_COLORS = {
  grass: 0x4a7a5e,
  floor_indoor: 0x6e6863,
  stage: 0x5a4a8a,
  path: 0x8a7a5a,
  bridge: 0x6a4a3a,
  water: 0x2a4a6a,
  wall: 0x2a2a2a,
};

/** Walls render slightly raised so the silhouette reads at iso angles. */
const WALL_HEIGHT = 0.5;

export class Island {
  /** @param {string} id */
  constructor(id) {
    const cfg = /** @type {Record<string, IslandDef>} */ (getConfig('islands'));
    const def = cfg[id];
    if (!def) throw new Error(`Island "${id}" not found in islands.json`);

    /** @type {IslandDef} */
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.rarity = def.rarity;
    this.encounterTable = def.encounterTable;
    this.width = def.width;
    this.height = def.height;

    /** @type {string[][]} tiles[y][x] = tileType */
    this.tiles = this.#parseTiles(def);

    this.group = new THREE.Group();
    this.#buildMeshes();

    /**
     * Origin offset so the island's center sits at world (0, 0, 0).
     * Cached for tileToWorld() lookups. Y is nudged a hair above
     * zero to avoid z-fighting with the renderer's placeholder
     * ground plane (which the battle scene reuses as its arena
     * floor — see engine/renderer.js).
     */
    this.originX = -(this.width - 1) / 2;
    this.originZ = -(this.height - 1) / 2;
    this.group.position.set(this.originX, 0.01, this.originZ);
  }

  /**
   * Resolve the tile glyph grid into a 2D array of tileType strings.
   *
   * @param {IslandDef} def
   * @returns {string[][]}
   */
  #parseTiles(def) {
    /** @type {string[][]} */
    const out = [];
    for (let y = 0; y < def.height; y++) {
      const row = def.tiles[y] ?? '';
      /** @type {string[]} */
      const r = [];
      for (let x = 0; x < def.width; x++) {
        const glyph = row[x] ?? 'W';
        const type = def.legend[glyph] ?? 'wall';
        r.push(type);
      }
      out.push(r);
    }
    return out;
  }

  /**
   * Build one mesh per tile. For an island this size the draw-call
   * count is negligible; if islands grow we'd swap to InstancedMesh
   * per design doc §30.3.
   */
  #buildMeshes() {
    const tileGeom = new THREE.PlaneGeometry(1, 1);
    const wallGeom = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const type = this.tiles[y][x];
        const color = TILE_COLORS[/** @type {keyof typeof TILE_COLORS} */ (type)] ?? 0x444444;

        if (type === 'wall') {
          const wall = new THREE.Mesh(
            wallGeom,
            new THREE.MeshStandardMaterial({ color })
          );
          wall.position.set(x, WALL_HEIGHT / 2, y);
          this.group.add(wall);
        } else {
          const tile = new THREE.Mesh(
            tileGeom,
            new THREE.MeshStandardMaterial({ color })
          );
          tile.rotation.x = -Math.PI / 2;
          tile.position.set(x, 0, y);
          this.group.add(tile);
        }
      }
    }
  }

  /**
   * Convert a tile coordinate into world (x, y, z). The island group
   * already carries the centering offset, so consumers parented to
   * the group can pass the raw tile coords; consumers placed on the
   * scene root (like the player) call this helper.
   *
   * @param {number} tx
   * @param {number} ty
   * @param {number} [yOffset]
   * @returns {{ x: number, y: number, z: number }}
   */
  tileToWorld(tx, ty, yOffset = 0) {
    return {
      x: this.originX + tx,
      y: yOffset,
      z: this.originZ + ty,
    };
  }

  /**
   * Look up the tile type at a coordinate. Out-of-bounds returns
   * 'wall' so callers can treat the edge as impassable without
   * branching.
   *
   * @param {number} tx
   * @param {number} ty
   */
  tileTypeAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 'wall';
    return this.tiles[ty][tx];
  }

  /** @param {number} tx @param {number} ty */
  isWalkable(tx, ty) {
    const t = this.tileTypeAt(tx, ty);
    if (t === 'wall' || t === 'water') return false;
    return true;
  }

  get spawnTile() {
    return this.def.spawnTile;
  }
}
