// @ts-check

import { eventBus } from './eventBus.js';

/**
 * Keyboard input manager. Tracks held keys, single-frame "just pressed"
 * events, and emits per-event signals on the EventBus so systems can
 * react without polling every frame.
 *
 * Gamepad support (per design doc §3.3 "gamepad-ready") is a
 * post-hackathon addition; the slice ships keyboard-only.
 */
class InputManager {
  /** @type {Set<string>} */
  #pressed = new Set();
  /** @type {Set<string>} */
  #justPressed = new Set();

  attach() {
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
  }

  detach() {
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
    this.#pressed.clear();
    this.#justPressed.clear();
  }

  /** Clear single-press flags. Call once per frame after game logic. */
  endFrame() {
    this.#justPressed.clear();
  }

  /**
   * @param {string} code  KeyboardEvent.code, e.g. 'KeyZ', 'Space'
   */
  isHeld(code) {
    return this.#pressed.has(code);
  }

  /**
   * Returns true exactly once — on the frame the key transitions from
   * up to down. Cleared by endFrame().
   *
   * @param {string} code
   */
  wasPressed(code) {
    return this.#justPressed.has(code);
  }

  /** @param {KeyboardEvent} e */
  #onKeyDown = (e) => {
    if (this.#pressed.has(e.code)) return; // ignore OS auto-repeat
    this.#pressed.add(e.code);
    this.#justPressed.add(e.code);
    eventBus.emit('input.keyDown', {
      code: e.code,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
  };

  /** @param {KeyboardEvent} e */
  #onKeyUp = (e) => {
    this.#pressed.delete(e.code);
    eventBus.emit('input.keyUp', {
      code: e.code,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
  };

  #onBlur = () => {
    // Drop all held keys when the window loses focus, otherwise keys
    // can get stuck pressed if the user alt-tabs mid-press.
    this.#pressed.clear();
    this.#justPressed.clear();
  };

  /**
   * Programmatically mark a key as held. Used by pointer.js so that
   * on-screen virtual D-pads register as held keys for systems that
   * read input.isHeld() (player movement, etc.). Idempotent — does
   * nothing if the key is already pressed, just like the real
   * keydown handler ignoring OS auto-repeat.
   *
   * @param {string} code
   */
  simulateDown(code) {
    if (this.#pressed.has(code)) return;
    this.#pressed.add(code);
    this.#justPressed.add(code);
    eventBus.emit('input.keyDown', {
      code,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
  }

  /**
   * Counterpart to simulateDown — clears the held flag and emits the
   * keyUp event. Safe to call when the key isn't currently held.
   *
   * @param {string} code
   */
  simulateUp(code) {
    if (!this.#pressed.has(code)) return;
    this.#pressed.delete(code);
    eventBus.emit('input.keyUp', {
      code,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
  }
}

export const inputManager = new InputManager();
