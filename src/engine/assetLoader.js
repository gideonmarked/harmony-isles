// @ts-check

import * as THREE from 'three';

import { eventBus } from './eventBus.js';

/**
 * Asset loader — design doc §27.9.
 *
 * Wraps `THREE.TextureLoader` with three things the rest of the
 * engine wants:
 *
 *   1. **Manifest-driven lookup.** Callers ask for a logical id
 *      (`'rivals.riffLord'`); the loader resolves it to a path and
 *      caches the resulting Texture.
 *
 *   2. **Loud failures.** When a registered asset fails to load
 *      (404, decode error, etc.) the loader resolves with a magenta
 *      checker pattern so the missing slot is *visible* on the
 *      stage rather than silently invisible. §27.9 explicitly calls
 *      for this — it pairs with the bbox debug overlay (§27.10) to
 *      make missing-art bugs unmissable.
 *
 *   3. **Promise + sync API.** `loadTexture(id)` returns a Promise
 *      so consumers can await; `getTexture(id)` returns the cached
 *      texture or null for hot paths that can't await.
 *
 * The loader is intentionally minimal — it doesn't deal with sprite
 * atlases, animation frame extraction, or asset hot-reload. Those
 * sit on top once we have real sprite art to test against.
 *
 * Manifest shape (`src/configs/assetManifest.json`):
 * ```json
 * {
 *   "sprites": {
 *     "player.starter":   "/assets/sprites/player/starter.png",
 *     "rivals.riffLord":  "/assets/sprites/rivals/riffLord.png"
 *   },
 *   "tilemaps": {
 *     "arena": "/assets/maps/arena.json"
 *   }
 * }
 * ```
 *
 * The `sprites.*` and `tilemaps.*` namespaces are conventions, not
 * enforced — anything goes. Lookup is by full key (`'sprites.foo'`
 * or `'rivals.foo'`); the namespace is just for human organization.
 */

/**
 * @typedef {object} AssetManifest
 * @property {Record<string, string>} [sprites]
 * @property {Record<string, string>} [tilemaps]
 * @property {Record<string, string>} [audio]
 */

/** Magenta checker — 8x8, alternating pure magenta and dark. Loud. */
function makeMagentaFallback() {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  const magenta = [255, 0, 255, 255];
  const dark = [40, 0, 40, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = (x + y) % 2 === 0 ? magenta : dark;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

class AssetLoader {
  /** @type {THREE.TextureLoader} */
  #threeLoader = new THREE.TextureLoader();
  /** @type {Map<string, string>} */
  #paths = new Map();
  /** @type {Map<string, THREE.Texture>} */
  #cache = new Map();
  /** @type {Map<string, Promise<THREE.Texture>>} */
  #inflight = new Map();
  /** @type {THREE.Texture | null} */
  #fallback = null;

  /** Lazily-built magenta texture. Shared across all fallback calls. */
  getFallbackTexture() {
    if (!this.#fallback) this.#fallback = makeMagentaFallback();
    return this.#fallback;
  }

  /**
   * Bulk-register a manifest. Flattens nested namespaces with `.` so
   * `sprites.player.starter` becomes the lookup key.
   *
   * @param {AssetManifest} manifest
   */
  registerManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return;
    /** @type {(prefix: string, obj: any) => void} */
    const walk = (prefix, obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') {
          this.#paths.set(key, v);
        } else {
          walk(key, v);
        }
      }
    };
    walk('', manifest);
  }

  /** True if a path has been registered for `id`. */
  hasManifestEntry(id) {
    return this.#paths.has(id);
  }

  /** Sync getter — cached texture or null. Use for hot paths. */
  getTexture(id) {
    return this.#cache.get(id) ?? null;
  }

  /**
   * Load (or return cached) texture for the manifest-registered id.
   * On error, resolves with the magenta fallback so the caller's
   * material has *something* renderable. Emits `asset.loaded` /
   * `asset.failed` for telemetry / debug overlays.
   *
   * @param {string} id
   * @returns {Promise<THREE.Texture>}
   */
  loadTexture(id) {
    const cached = this.#cache.get(id);
    if (cached) return Promise.resolve(cached);
    const inflight = this.#inflight.get(id);
    if (inflight) return inflight;

    const path = this.#paths.get(id);
    if (!path) {
      // No registration is different from a load failure — stay quiet
      // about it (the caller is opting into the fallback) but still
      // hand back the magenta texture so something renders.
      const fallback = this.getFallbackTexture();
      return Promise.resolve(fallback);
    }

    const promise = new Promise(
      /** @param {(t: THREE.Texture) => void} resolve */
      (resolve) => {
        this.#threeLoader.load(
          path,
          (tex) => {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            this.#cache.set(id, tex);
            this.#inflight.delete(id);
            eventBus.emit('asset.loaded', { id, path });
            resolve(tex);
          },
          undefined,
          (err) => {
            console.error(`assetLoader: failed to load "${id}" from ${path}`, err);
            this.#inflight.delete(id);
            eventBus.emit('asset.failed', { id, path, error: String(err) });
            resolve(this.getFallbackTexture());
          }
        );
      }
    );
    this.#inflight.set(id, promise);
    return promise;
  }

  /** Diagnostic dump for the bbox debug overlay. */
  debugSnapshot() {
    return {
      registered: Array.from(this.#paths.entries()),
      cached: Array.from(this.#cache.keys()),
      inflight: Array.from(this.#inflight.keys()),
    };
  }
}

export const assetLoader = new AssetLoader();
