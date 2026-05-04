// @ts-check

import { bindAsClick } from '../util/pointer.js';

/**
 * Song picker — DOM overlay listing the player's available songs with
 * energy cost, scaling stat, and power. Mirrors itemMenu in shape so
 * battleScene treats the two submenus the same way.
 */
class SongMenu {
  /** @type {HTMLElement | null} */
  #root = null;

  /** @type {((songId: string) => void) | null} */
  #onSelect = null;

  /** @type {(() => void) | null} */
  #onCancel = null;

  /**
   * @typedef {object} SongEntry
   * @property {string} id
   * @property {string} name
   * @property {string} type
   * @property {number} power
   * @property {string} scalesOff
   * @property {number} energy
   * @property {boolean} affordable
   *
   * @type {SongEntry[]}
   */
  #entries = [];

  /** @type {(() => void)[]} */
  #unbinds = [];

  /**
   * @param {SongEntry[]} entries
   * @param {{ mp: number, mpMax: number }} energyState
   * @param {(songId: string) => void} onSelect
   * @param {() => void} onCancel
   */
  show(entries, energyState, onSelect, onCancel) {
    this.hide();
    this.#entries = entries;
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;

    const root = document.createElement('div');
    root.id = 'song-menu';
    root.innerHTML = /* html */ `
      <style>
        #song-menu {
          position: fixed; left: 50%; bottom: 200px; transform: translateX(-50%);
          width: 540px; padding: 14px 16px;
          background: rgba(14, 18, 26, 0.92);
          border: 1px solid #ffd884;
          border-radius: 8px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; font-size: 13px;
          box-shadow: 0 0 18px rgba(255, 216, 132, 0.25);
          z-index: 5;
        }
        #song-menu .title {
          font-size: 12px; letter-spacing: 2px; color: #ffd884;
          text-transform: uppercase; margin-bottom: 4px;
        }
        #song-menu .energy {
          font-size: 12px; color: #c8d4e0; margin-bottom: 10px;
        }
        #song-menu .energy strong { color: #fffae0; }
        #song-menu .row {
          display: flex; align-items: baseline; gap: 10px; padding: 5px 0;
        }
        #song-menu .row.locked { opacity: 0.4; }
        #song-menu .row.tappable {
          cursor: pointer; border-radius: 4px;
          padding: 5px 6px; margin: 0 -6px;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        #song-menu .row.tappable:hover, #song-menu .row.tappable:active {
          background: rgba(255, 216, 132, 0.10);
        }
        #song-menu .close-btn {
          margin-top: 12px; padding: 6px 14px;
          background: rgba(255, 216, 132, 0.10);
          border: 1px solid #ffd884; border-radius: 4px;
          color: #e8edf2; font-family: inherit; font-size: 12px;
          letter-spacing: 1px; cursor: pointer;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        #song-menu .key {
          flex: 0 0 22px; color: #ffd884; font-weight: 800;
        }
        #song-menu .name { flex: 0 0 130px; font-weight: 700; color: #fffae0; }
        #song-menu .stat {
          flex: 0 0 70px; font-size: 11px; color: #8a96a4; letter-spacing: 1px;
          text-transform: uppercase;
        }
        #song-menu .power {
          flex: 0 0 60px; font-size: 12px; color: #c8d4e0;
          font-variant-numeric: tabular-nums;
        }
        #song-menu .cost {
          flex: 0 0 60px; text-align: right; color: #6ec1ff;
          font-variant-numeric: tabular-nums;
        }
        #song-menu .row.locked .cost { color: #c98a8a; }
        #song-menu .hint { margin-top: 10px; font-size: 11px; color: #8a96a4; }
        #song-menu .hint kbd {
          display: inline-block; padding: 1px 5px;
          border: 1px solid #3a4756; border-radius: 4px;
          font-family: inherit; font-size: 11px; color: #e8edf2;
        }
      </style>
      <div class="title">Choose a song</div>
      <div class="energy">Energy <strong>${energyState.mp}</strong> / ${energyState.mpMax}</div>
      <div class="rows">
        ${entries
          .map(
            (e, i) => /* html */ `
            <div class="row ${e.affordable ? 'tappable' : 'locked'}" data-id="${e.id}">
              <span class="key">${i + 1}</span>
              <span class="name">${e.name}</span>
              <span class="stat">${e.scalesOff}</span>
              <span class="power">${e.power.toFixed(1)}× pwr</span>
              <span class="cost">${e.energy} En</span>
            </div>`
          )
          .join('')}
      </div>
      <div class="hint">
        <kbd>1</kbd>–<kbd>${Math.max(1, entries.length)}</kbd> select &nbsp;·&nbsp;
        <kbd>Z</kbd> / <kbd>Esc</kbd> cancel
      </div>
      <button class="close-btn" data-bind="cancel">Cancel</button>
    `;
    document.body.appendChild(root);
    this.#root = root;

    root.querySelectorAll('.row.tappable').forEach((rowEl) => {
      const id = rowEl.getAttribute('data-id');
      if (!id) return;
      this.#unbinds.push(
        bindAsClick(/** @type {HTMLElement} */ (rowEl), () => {
          const cb = this.#onSelect;
          this.hide();
          cb?.(id);
        })
      );
    });
    const cancelBtn = /** @type {HTMLElement | null} */ (
      root.querySelector('[data-bind="cancel"]')
    );
    if (cancelBtn) {
      this.#unbinds.push(
        bindAsClick(cancelBtn, () => {
          const cb = this.#onCancel;
          this.hide();
          cb?.();
        })
      );
    }
  }

  hide() {
    for (const u of this.#unbinds) u();
    this.#unbinds = [];
    this.#root?.remove();
    this.#root = null;
    this.#entries = [];
    this.#onSelect = null;
    this.#onCancel = null;
  }

  /**
   * @param {string} code
   * @returns {boolean}
   */
  handleKey(code) {
    if (!this.#root) return false;
    if (code === 'Escape' || code === 'KeyZ') {
      const cb = this.#onCancel;
      this.hide();
      cb?.();
      return true;
    }
    const match = /^Digit([1-9])$/.exec(code);
    if (!match) return false;
    const idx = Number(match[1]) - 1;
    const entry = this.#entries[idx];
    if (!entry || !entry.affordable) return false;
    const cb = this.#onSelect;
    this.hide();
    cb?.(entry.id);
    return true;
  }

  get isOpen() {
    return this.#root !== null;
  }
}

export const songMenu = new SongMenu();
