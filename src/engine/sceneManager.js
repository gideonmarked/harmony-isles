// @ts-check

import { eventBus } from './eventBus.js';

/**
 * @typedef {object} SceneContext
 * @property {import('three').Scene} scene
 * @property {import('three').OrthographicCamera} camera
 *
 * @typedef {object} Scene
 * @property {string} id
 * @property {(ctx: SceneContext) => void | Promise<void>} [enter]
 * @property {(dt: number, ctx: SceneContext) => void} [update]
 * @property {() => void | Promise<void>} [exit]
 */

/**
 * Scene manager — owns which gameplay screen is active (title, battle,
 * etc.) and transitions between them. Each scene has a small
 * lifecycle: enter / update / exit. The heavy work lives in the
 * systems each scene coordinates.
 */
class SceneManager {
  /** @type {Map<string, Scene>} */
  #scenes = new Map();
  /** @type {Scene | null} */
  #current = null;
  /** @type {SceneContext | null} */
  #ctx = null;

  /** @param {SceneContext} ctx */
  init(ctx) {
    this.#ctx = ctx;
  }

  /** @param {Scene} scene */
  register(scene) {
    this.#scenes.set(scene.id, scene);
  }

  /** @param {string} id */
  async transition(id) {
    const next = this.#scenes.get(id);
    if (!next) {
      console.warn(`SceneManager: unknown scene "${id}"`);
      return;
    }
    if (this.#current) {
      await this.#current.exit?.();
      eventBus.emit('scene.exited', { id: this.#current.id });
    }
    this.#current = next;
    if (this.#ctx) {
      await next.enter?.(this.#ctx);
    }
    eventBus.emit('scene.entered', { id: next.id });
  }

  /** @param {number} dt  Seconds since last frame. */
  update(dt) {
    if (this.#current?.update && this.#ctx) {
      this.#current.update(dt, this.#ctx);
    }
  }

  get currentId() {
    return this.#current?.id ?? null;
  }
}

export const sceneManager = new SceneManager();
