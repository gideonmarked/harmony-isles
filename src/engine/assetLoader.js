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
 *
 * @typedef {Record<string, THREE.Texture[]>} CharacterAnimSet
 */

/** Animation states probed under <id>/animations/. */
const CHARACTER_ANIM_STATES = ['idle', 'ready', 'strum', 'perform'];

/** Cap on contiguous frames per animation. Generous — sprites cap at ~9. */
const MAX_FRAMES_PER_ANIM = 16;

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
  /** @type {Map<string, CharacterAnimSet>} */
  #charAnimCache = new Map();
  /** @type {Map<string, Promise<CharacterAnimSet>>} */
  #charAnimInflight = new Map();

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

  /**
   * Load every animation a character ships with. Convention:
   *   /assets/sprites/characters/<id>/animations/<state>/[<direction>/]frame_NNN.png
   *
   * Probes `idle` / `ready` / `strum` / `perform`. For each state the
   * loader tries the direct folder first, then a `south-east/`
   * sub-directory (the exporter sometimes nests by direction). It
   * loads `frame_000` to confirm the animation exists, then
   * parallel-probes 1..MAX-1 and stops at the first 404 — the array
   * is the contiguous run.
   *
   * Missing states resolve to empty arrays; the caller falls back to
   * the character's `default.png`.
   *
   * @param {string} id  Folder name under `characters/`.
   * @returns {Promise<CharacterAnimSet>}
   */
  loadCharacterAnimations(id) {
    const cached = this.#charAnimCache.get(id);
    if (cached) return Promise.resolve(cached);
    const inflight = this.#charAnimInflight.get(id);
    if (inflight) return inflight;

    const promise = (async () => {
      /** @type {CharacterAnimSet} */
      const out = {};
      // Run all four states in parallel — the exporter writes all of
      // them at once, so there's no benefit to sequencing.
      const results = await Promise.all(
        CHARACTER_ANIM_STATES.map((state) => this.#probeAnimation(id, state))
      );
      CHARACTER_ANIM_STATES.forEach((state, i) => {
        out[state] = results[i];
      });
      this.#charAnimCache.set(id, out);
      this.#charAnimInflight.delete(id);
      eventBus.emit('asset.characterLoaded', {
        id,
        frameCounts: Object.fromEntries(
          Object.entries(out).map(([k, v]) => [k, v.length])
        ),
      });
      return out;
    })();
    this.#charAnimInflight.set(id, promise);
    return promise;
  }

  /** Sync getter — the cached animation set, or null until ready. */
  getCharacterAnimations(id) {
    return this.#charAnimCache.get(id) ?? null;
  }

  /**
   * Load `<id>/default.png`. Resolves to null when the folder doesn't
   * exist — the caller decides the fallback (Character tries the
   * global default art, then a flat color quad). Distinct from
   * {@link loadTexture}: this path is silent on 404 so probing
   * convention-based folders doesn't spam the console.
   *
   * @param {string} id
   * @returns {Promise<THREE.Texture | null>}
   */
  loadCharacterDefault(id) {
    return this.#tryLoad(`/assets/sprites/characters/${id}/default.png`);
  }

  /**
   * Try the direct path then the per-direction nested path. Returns
   * the contiguous array of frame textures; empty if the animation
   * isn't present.
   *
   * @param {string} id @param {string} state
   * @returns {Promise<THREE.Texture[]>}
   */
  async #probeAnimation(id, state) {
    const candidates = [
      `/assets/sprites/characters/${id}/animations/${state}`,
      `/assets/sprites/characters/${id}/animations/${state}/south-east`,
    ];
    for (const root of candidates) {
      const f0 = await this.#tryLoad(`${root}/frame_000.png`);
      if (!f0) continue;
      const probes = [];
      for (let i = 1; i < MAX_FRAMES_PER_ANIM; i++) {
        const n = String(i).padStart(3, '0');
        probes.push(this.#tryLoad(`${root}/frame_${n}.png`));
      }
      const rest = await Promise.all(probes);
      /** @type {THREE.Texture[]} */
      const frames = [f0];
      for (const tex of rest) {
        if (!tex) break;
        frames.push(tex);
      }
      return frames;
    }
    return [];
  }

  /**
   * Bare TextureLoader call that resolves null on error. Used by the
   * frame prober — failures are *expected* (probing past the last
   * frame), so we suppress the magenta-fallback path the public
   * `loadTexture` provides.
   *
   * @param {string} url
   * @returns {Promise<THREE.Texture | null>}
   */
  #tryLoad(url) {
    return new Promise((resolve) => {
      this.#threeLoader.load(
        url,
        (tex) => {
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });
  }

  /** Diagnostic dump for the bbox debug overlay. */
  debugSnapshot() {
    return {
      registered: Array.from(this.#paths.entries()),
      cached: Array.from(this.#cache.keys()),
      inflight: Array.from(this.#inflight.keys()),
      characters: Array.from(this.#charAnimCache.keys()),
    };
  }
}

export const assetLoader = new AssetLoader();
