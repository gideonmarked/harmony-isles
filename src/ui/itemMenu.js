// @ts-check

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

  /**
   * @param {{ id: string, name: string, summary: string, count: number }[]} entries
   * @param {(itemId: string) => void} onSelect
   * @param {() => void} onCancel
   */
  show(entries, onSelect, onCancel) {
    this.hide();
    this.#entries = entries;
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;

    const root = document.createElement('div');
    root.id = 'item-menu';
    root.innerHTML = /* html */ `
      <style>
        #item-menu {
          position: fixed; left: 50%; bottom: 200px; transform: translateX(-50%);
          width: 460px; padding: 14px 16px;
          background: rgba(14, 18, 26, 0.92);
          border: 1px solid #6ec1ff;
          border-radius: 8px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; font-size: 13px; pointer-events: none;
          box-shadow: 0 0 18px rgba(110, 193, 255, 0.25);
          z-index: 5;
        }
        #item-menu .title {
          font-size: 12px; letter-spacing: 2px; color: #6ec1ff;
          text-transform: uppercase; margin-bottom: 10px;
        }
        #item-menu .row {
          display: flex; align-items: baseline; gap: 12px; padding: 4px 0;
        }
        #item-menu .row.empty { color: #8a96a4; font-style: italic; }
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
      <div class="title">Inventory</div>
      <div class="rows">
        ${entries.length === 0
          ? '<div class="row empty">No items in inventory.</div>'
          : entries
              .map(
                (e, i) => /* html */ `
            <div class="row">
              <span class="key">${i + 1}</span>
              <span class="name">${e.name}</span>
              <span class="summary">${e.summary}</span>
              <span class="count">×${e.count}</span>
            </div>`
              )
              .join('')}
      </div>
      <div class="hint">
        <kbd>1</kbd>–<kbd>${Math.max(1, entries.length)}</kbd> use &nbsp;·&nbsp;
        <kbd>I</kbd> / <kbd>Esc</kbd> close
      </div>
    `;
    document.body.appendChild(root);
    this.#root = root;
  }

  hide() {
    this.#root?.remove();
    this.#root = null;
    this.#entries = [];
    this.#onSelect = null;
    this.#onCancel = null;
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
