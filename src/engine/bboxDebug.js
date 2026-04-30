// @ts-check

import * as THREE from 'three';

import { eventBus } from './eventBus.js';

/**
 * Bounding-box debug overlay — design doc §27.10.
 *
 * Toggled by Shift+B from anywhere in the game. When on, every Mesh
 * in the scene graph gets a magenta wireframe Box3 helper attached
 * to it, so missing-asset bugs and overlap issues are visible on
 * stage. Helpers update in lockstep with their target each frame
 * via `update()`.
 *
 * Pairs with the asset loader's magenta-checker fallback (§27.9):
 * a missing sprite renders as a magenta checker AND a magenta bbox,
 * which is hard to miss in playtests.
 *
 * Usage:
 *
 *   bboxDebug.attach(scene);   // call once at boot
 *   bboxDebug.update();        // call once per frame in the render loop
 *
 * The debug listener handles the Shift+B toggle internally — no
 * scene needs to opt in.
 */
class BboxDebug {
  /** @type {THREE.Scene | null} */
  #scene = null;
  /** @type {boolean} */
  #enabled = false;
  /** @type {Map<THREE.Object3D, THREE.BoxHelper>} */
  #helpers = new Map();
  /** @type {(() => void) | null} */
  #unsub = null;

  /**
   * Attach to the global scene. The toggle key handler is wired here
   * so subsequent show/hide cycles don't double-subscribe.
   *
   * @param {THREE.Scene} scene
   */
  attach(scene) {
    if (this.#scene) return;
    this.#scene = scene;
    this.#unsub = eventBus.on(
      'input.keyDown',
      /** @param {{ code: string, shiftKey?: boolean }} p */
      (p) => {
        if (p?.code === 'KeyB' && p.shiftKey) this.toggle();
      }
    );
  }

  /** Detach. Removes all helpers and unsubscribes the toggle. */
  detach() {
    if (this.#unsub) {
      this.#unsub();
      this.#unsub = null;
    }
    this.#hide();
    this.#scene = null;
  }

  toggle() {
    if (this.#enabled) this.#hide();
    else this.#show();
    eventBus.emit('debug.bboxToggled', { enabled: this.#enabled });
  }

  get enabled() {
    return this.#enabled;
  }

  #show() {
    if (!this.#scene) return;
    this.#enabled = true;
    this.#scene.traverse((obj) => {
      if (
        /** @type {any} */ (obj).isMesh &&
        !this.#helpers.has(obj) &&
        // BoxHelpers are themselves Object3Ds — don't recurse onto our own helpers.
        !this.#isHelper(obj)
      ) {
        const helper = new THREE.BoxHelper(obj, 0xff00ff);
        helper.userData.__bboxHelper = true;
        this.#helpers.set(obj, helper);
        this.#scene.add(helper);
      }
    });
  }

  #hide() {
    this.#enabled = false;
    if (this.#scene) {
      for (const helper of this.#helpers.values()) {
        this.#scene.remove(helper);
        helper.dispose?.();
      }
    }
    this.#helpers.clear();
  }

  /**
   * Sync helper positions/sizes to their targets. Cheap when disabled
   * (early-return). Also picks up freshly-spawned meshes so the
   * overlay stays current when scenes swap mid-run.
   */
  update() {
    if (!this.#enabled || !this.#scene) return;
    // Catch newly-spawned meshes since the last toggle.
    this.#scene.traverse((obj) => {
      if (
        /** @type {any} */ (obj).isMesh &&
        !this.#helpers.has(obj) &&
        !this.#isHelper(obj)
      ) {
        const helper = new THREE.BoxHelper(obj, 0xff00ff);
        helper.userData.__bboxHelper = true;
        this.#helpers.set(obj, helper);
        this.#scene.add(helper);
      }
    });
    // Drop helpers whose target has been removed from the scene.
    for (const [obj, helper] of this.#helpers) {
      if (!obj.parent) {
        this.#scene.remove(helper);
        helper.dispose?.();
        this.#helpers.delete(obj);
      } else {
        helper.update();
      }
    }
  }

  /** @param {THREE.Object3D} obj */
  #isHelper(obj) {
    return Boolean(obj.userData?.__bboxHelper);
  }
}

export const bboxDebug = new BboxDebug();
