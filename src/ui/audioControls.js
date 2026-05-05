// @ts-check

import {
  getGlobalVolume,
  setGlobalVolume,
  isGlobalMuted,
  setGlobalMute,
} from '../engine/audio.js';
import { bindAsClick } from '../util/pointer.js';

/**
 * Persistent on-screen audio controls — three buttons in the
 * top-right corner: volume down, volume up, mute toggle. A small
 * readout in the middle shows current volume as a percentage.
 *
 * Mounted once at boot in main.js; survives every scene transition
 * because it lives outside the canvas. Volume + mute state are
 * persisted to localStorage by the audio module.
 */

const VOLUME_STEP = 0.1;

class AudioControls {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unbinds = [];

  show() {
    if (this.#root) return;

    const root = document.createElement('div');
    root.id = 'audio-controls';
    root.innerHTML = /* html */ `
      <style>
        #audio-controls {
          position: fixed; top: 12px; right: 12px;
          display: flex; align-items: center; gap: 4px;
          padding: 6px 8px;
          background: rgba(14, 18, 26, 0.78);
          border: 1px solid #2a3340; border-radius: 8px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; font-size: 12px;
          z-index: 100;
          pointer-events: auto;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        #audio-controls button {
          width: 28px; height: 28px;
          padding: 0;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid #3a4756; border-radius: 5px;
          color: #e8edf2; font-family: inherit; font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          touch-action: manipulation;
          display: flex; align-items: center; justify-content: center;
        }
        #audio-controls button:active {
          background: rgba(110, 193, 255, 0.18);
          border-color: #6ec1ff;
        }
        #audio-controls button:disabled {
          opacity: 0.4; cursor: not-allowed;
        }
        #audio-controls .readout {
          min-width: 36px; text-align: center;
          color: #c8d4e0; letter-spacing: 0.5px;
          font-variant-numeric: tabular-nums;
        }
        #audio-controls .readout.muted {
          color: #c98a8a;
          text-decoration: line-through;
        }
        #audio-controls .mute-btn.on {
          background: rgba(232, 90, 90, 0.18);
          border-color: #e85a5a; color: #ffd0d0;
        }
      </style>
      <button data-bind="down" title="Volume down">−</button>
      <span class="readout" data-bind="readout">100%</span>
      <button data-bind="up" title="Volume up">+</button>
      <button class="mute-btn" data-bind="mute" title="Mute / unmute">🔊</button>
    `;
    document.body.appendChild(root);
    this.#root = root;

    const downBtn = this.#qs('down');
    const upBtn = this.#qs('up');
    const muteBtn = this.#qs('mute');
    if (downBtn) {
      this.#unbinds.push(bindAsClick(downBtn, () => this.#nudge(-VOLUME_STEP)));
    }
    if (upBtn) {
      this.#unbinds.push(bindAsClick(upBtn, () => this.#nudge(VOLUME_STEP)));
    }
    if (muteBtn) {
      this.#unbinds.push(bindAsClick(muteBtn, () => this.#toggleMute()));
    }

    this.#refresh();
  }

  hide() {
    for (const u of this.#unbinds) u();
    this.#unbinds = [];
    this.#root?.remove();
    this.#root = null;
  }

  /** @param {number} delta */
  #nudge(delta) {
    setGlobalVolume(getGlobalVolume() + delta);
    // Nudging volume implicitly unmutes — otherwise the +/- buttons
    // feel broken when the user has muted and forgotten.
    if (isGlobalMuted() && delta > 0) setGlobalMute(false);
    this.#refresh();
  }

  #toggleMute() {
    setGlobalMute(!isGlobalMuted());
    this.#refresh();
  }

  #refresh() {
    if (!this.#root) return;
    const vol = getGlobalVolume();
    const muted = isGlobalMuted();
    const readout = this.#qs('readout');
    if (readout) {
      readout.textContent = `${Math.round(vol * 100)}%`;
      readout.classList.toggle('muted', muted);
    }
    const muteBtn = /** @type {HTMLButtonElement | null} */ (this.#qs('mute'));
    if (muteBtn) {
      muteBtn.textContent = muted ? '🔇' : '🔊';
      muteBtn.classList.toggle('on', muted);
    }
    const down = /** @type {HTMLButtonElement | null} */ (this.#qs('down'));
    if (down) down.disabled = vol <= 0;
    const up = /** @type {HTMLButtonElement | null} */ (this.#qs('up'));
    if (up) up.disabled = vol >= 1;
  }

  /** @param {string} key */
  #qs(key) {
    return /** @type {HTMLElement | null} */ (
      this.#root?.querySelector(`[data-bind="${key}"]`) ?? null
    );
  }
}

export const audioControls = new AudioControls();
