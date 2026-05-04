// @ts-check

import { eventBus } from '../engine/eventBus.js';
import { inputManager } from '../engine/inputManager.js';

/**
 * Pointer / touch input helpers.
 *
 * All scenes already listen for `input.keyDown` events, so the
 * fastest way to make the game playable without a keyboard is to
 * translate clicks and taps into the same events. Drop a button on
 * screen, bind it with {@link bindAsKey}, and every existing scene
 * handler picks it up unchanged.
 *
 * Touch event handlers are attached with `passive: false` and call
 * `preventDefault()` so iOS doesn't synthesize a 300 ms-late mouse
 * click after the touch (which would re-fire the binding).
 */

/**
 * Wire `el` so a click or tap emits an `input.keyDown` event with the
 * given key code. Returns an unbind function.
 *
 * @param {HTMLElement} el
 * @param {string} code  KeyboardEvent.code (e.g. 'KeyZ', 'Escape', 'Digit1')
 * @returns {() => void}
 */
export function bindAsKey(el, code) {
  return bindAsClick(el, () => {
    eventBus.emit('input.keyDown', { code });
  });
}

/**
 * Wire `el` so a click or tap calls `fn`. Handles mouse and touch
 * with the same semantics, swallowing the synthetic post-touch
 * mouse click so the handler fires exactly once per gesture.
 *
 * @param {HTMLElement} el
 * @param {(ev: Event) => void} fn
 * @returns {() => void}
 */
export function bindAsClick(el, fn) {
  let lastTouchAt = 0;
  /** @param {TouchEvent} e */
  const onTouch = (e) => {
    e.preventDefault();
    lastTouchAt = Date.now();
    fn(e);
  };
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    // Suppress the ghost click that follows a touch by ~300 ms on
    // legacy mobile webviews.
    if (Date.now() - lastTouchAt < 500) return;
    fn(e);
  };
  el.addEventListener('touchstart', onTouch, { passive: false });
  el.addEventListener('click', onClick);
  // Force pointer-events on. Many overlays set the root container to
  // `pointer-events: none` so clicks fall through to the canvas; any
  // child we make clickable has to opt back in explicitly or mouse
  // hit-testing skips it.
  el.style.pointerEvents = 'auto';
  el.style.cursor = el.style.cursor || 'pointer';
  el.style.touchAction = 'manipulation';
  return () => {
    el.removeEventListener('touchstart', onTouch);
    el.removeEventListener('click', onClick);
  };
}

/**
 * Hold-to-press button. While the pointer is on `el`, the key
 * registers as held in {@link inputManager} so systems that read
 * `isHeld()` (player movement, etc.) behave as if the key were
 * physically down. Releases on pointerup / cancel / leaving the
 * element.
 *
 * Uses Pointer Events so mouse and touch share the same code path
 * and multi-finger D-pads (e.g. up + right for diagonal) work out
 * of the box — each button has its own held state.
 *
 * @param {HTMLElement} el
 * @param {string} code
 * @returns {() => void}
 */
export function bindAsHeldKey(el, code) {
  let active = false;
  /** @param {PointerEvent} e */
  const down = (e) => {
    e.preventDefault();
    if (active) return;
    active = true;
    el.classList.add('held');
    inputManager.simulateDown(code);
  };
  const up = () => {
    if (!active) return;
    active = false;
    el.classList.remove('held');
    inputManager.simulateUp(code);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  el.style.pointerEvents = 'auto';
  el.style.cursor = el.style.cursor || 'pointer';
  el.style.touchAction = 'none';
  el.style.userSelect = 'none';
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('pointerleave', up);
    if (active) {
      active = false;
      inputManager.simulateUp(code);
    }
  };
}

/**
 * Multi-touch lane button — one finger per lane fires the bound key
 * independently. Used by the rhythm UI for D F J K. Holding the
 * finger down does not auto-repeat — you tap once per note, like
 * the keyboard equivalent.
 *
 * Mouse clicks are intentionally ignored: a mouse only has one
 * cursor, so it can't hit two lanes at the same instant the way
 * two fingers can. Forcing the rhythm round to keyboard-only on
 * desktop keeps timing parity between players. (Other UIs accept
 * mouse clicks via {@link bindAsClick}; rhythm is the lone holdout.)
 *
 * @param {HTMLElement} el
 * @param {string} code
 * @returns {() => void}
 */
export function bindLaneTap(el, code) {
  /** @param {TouchEvent} e */
  const onTouch = (e) => {
    // Each new touch on this element fires once. Existing touches
    // already in the changedTouches list aren't re-counted by the
    // browser, so this is naturally per-finger.
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      eventBus.emit('input.keyDown', { code });
    }
  };
  el.addEventListener('touchstart', onTouch, { passive: false });
  el.style.touchAction = 'manipulation';
  el.style.userSelect = 'none';
  return () => {
    el.removeEventListener('touchstart', onTouch);
  };
}
