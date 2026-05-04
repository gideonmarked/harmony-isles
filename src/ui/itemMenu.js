// @ts-check

import { bindAsClick } from '../util/pointer.js';

/**
 * Item submenu — DOM overlay listing the manager's current inventory
 * with hotkeys for selection. Opens on `I` during a player turn,
 * closes on Esc / I, and surfaces the chosen item id via callback.
 *
 * Keeps its own DOM lifecycle so battleScene only deals with
 * "show / hide / on selected" rather than DOM details.
 */
class ItemMenu {
  /** @type {HTMLElement | null} */
  #root = null;

  /** @type {((itemId: string) => void) | null} */
  #onSelect = null;

  /** @type {(() => void) | null} */
  #onCancel = null;

  /** @type {{ id: string, name: string, summary: string, count: number }[]} */
  #entries = [];

  /** True when the menu is opened just to view inventory — number
   *  keys are ignored, only Esc / I closes. */
  #readOnly = false;

  /** @type {(() => void)[]} */
  #unbinds = [];

  /**
   * @param {{ id: string, name: string, summary: string, count: number }[]} entries
   * @param {(itemId: string) => void} onSelect
   * @param {() => void} onCancel
   * @param {{ readOnly?: boolean }} [opts]
   */
  show(entries, onSelect, onCancel, opts = {}) {
    this.hide();
    this.#entries = entries;
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.#readOnly = !!opts.readOnly;

    const root = document.createElement('div');
    root.id = 'item-menu';
    root.classList.toggle('readonly', this.#readOnly);
    root.innerHTML = /* html */ `
      <style>
        /* Mid-battle (in-place) variant: small floating panel above
           the action bar so the player can still see the stage. */
        #item-menu {
          position: fixed; left: 50%; bottom: 200px; transform: translateX(-50%);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; font-size: 13px; pointer-events: none;
          z-index: 30;
        }
        #item-menu > .panel {
          width: 460px; padding: 14px 16px;
          background: rgba(14, 18, 26, 0.96);
          border: 1px solid #6ec1ff; border-radius: 8px;
          box-shadow: 0 0 18px rgba(110, 193, 255, 0.25);
        }
        /* Read-only "view inventory" variant: full-screen backdrop
           that occludes whatever scene UI is behind it. */
        #item-menu.readonly {
          inset: 0; left: 0; right: 0; top: 0; bottom: 0;
          transform: none;
          background: rgba(8, 10, 16, 0.82);
          backdrop-filter: blur(2px);
          display: flex; align-items: center; justify-content: center;
          pointer-events: auto;
          z-index: 60;
        }
        #item-menu .title {
          font-size: 12px; letter-spacing: 2px; color: #6ec1ff;
          text-transform: uppercase; margin-bottom: 10px;
        }
        #item-menu .row {
          display: flex; align-items: baseline; gap: 12px; padding: 4px 0;
        }
        #item-menu .row.empty { color: #8a96a4; font-style: italic; }
        #item-menu .row.tappable {
          pointer-events: auto; cursor: pointer;
          border-radius: 4px;
          padding: 4px 6px; margin: -4px -6px; padding-right: 6px;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        #item-menu .row.tappable:hover, #item-menu .row.tappable:active {
          background: rgba(110, 193, 255, 0.10);
        }
        #item-menu .close-btn {
          margin-top: 12px; padding: 6px 14px;
          background: rgba(110, 193, 255, 0.10);
          border: 1px solid #6ec1ff; border-radius: 4px;
          color: #e8edf2; font-family: inherit; font-size: 12px;
          letter-spacing: 1px; cursor: pointer;
          pointer-events: auto;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        #item-menu { pointer-events: none; }
        #item-menu .key {
          flex: 0 0 22px; color: #ffd884; font-weight: 800;
        }
        #item-menu .name { flex: 0 0 130px; font-weight: 700; color: #fffae0; }
        #item-menu .summary { flex: 1; color: #c8d4e0; font-size: 12px; }
        #item-menu .count { flex: 0 0 36px; text-align: right; color: #8a96a4; }
        #item-menu .hint { margin-top: 10px; font-size: 11px; color: #8a96a4; }
        #item-menu .hint kbd {
          display: inline-block; padding: 1px 5px;
          border: 1px solid #3a4756; border-radius: 4px;
          font-family: inherit; font-size: 11px; color: #e8edf2;
        }
      </style>
      <div class="panel">
        <div class="title">Inventory</div>
        <div class="rows">
          ${entries.length === 0
            ? '<div class="row empty">No items in inventory.</div>'
            : entries
                .map(
                  (e, i) => /* html */ `
              <div class="row ${this.#readOnly ? '' : 'tappable'}" data-id="${e.id}">
                <span class="key">${i + 1}</span>
                <span class="name">${e.name}</span>
                <span class="summary">${e.summary}</span>
                <span class="count">×${e.count}</span>
              </div>`
                )
                .join('')}
        </div>
        <div class="hint">
          ${this.#readOnly
            ? ''
            : `<kbd>1</kbd>–<kbd>${Math.max(1, entries.length)}</kbd> use &nbsp;·&nbsp;`}
          <kbd>I</kbd> / <kbd>Esc</kbd> close
        </div>
        <button class="close-btn" data-bind="close">Close</button>
      </div>
    `;
    document.body.appendChild(root);
    this.#root = root;

    // Tap-to-pick — wires each row's data-id back to the selection
    // callback. Read-only mode skips this so the rows are pure
    // display.
    if (!this.#readOnly) {
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
    }
    const closeBtn = /** @type {HTMLElement | null} */ (
      root.querySelector('[data-bind="close"]')
    );
    if (closeBtn) {
      this.#unbinds.push(
        bindAsClick(closeBtn, () => {
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
    this.#readOnly = false;
  }

  /**
   * Forward a key code into the menu. Returns true if the menu
   * consumed the key (selected an item or cancelled).
   *
   * @param {string} code
   * @returns {boolean}
   */
  handleKey(code) {
    if (!this.#root) return false;
    if (code === 'Escape' || code === 'KeyI') {
      const cb = this.#onCancel;
      this.hide();
      cb?.();
      return true;
    }
    if (this.#readOnly) return false;
    const match = /^Digit([1-9])$/.exec(code);
    if (!match) return false;
    const idx = Number(match[1]) - 1;
    const entry = this.#entries[idx];
    if (!entry) return false;
    const cb = this.#onSelect;
    this.hide();
    cb?.(entry.id);
    return true;
  }

  get isOpen() {
    return this.#root !== null;
  }
}

export const itemMenu = new ItemMenu();
