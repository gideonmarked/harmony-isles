// @ts-check

import { eventBus } from '../engine/eventBus.js';
import { getConfig } from '../engine/configService.js';
import { dispatch, getState, expToNextCred } from '../engine/gameState.js';

/**
 * Shop UI — two tabs:
 *
 *   ISLANDS  : credibility-gated tour expansion (§11.5 + §25.5)
 *   ITEMS    : consumables for battle (§25.4 + §20)
 *
 * Each row sits in one of four states:
 *   - owned     : (islands only) already bought; appears greyed-out
 *   - available : enough Cred AND enough Notes; "Buy" enabled
 *   - locked    : Cred too low; shows the unlock requirement (islands only)
 *   - poor      : Cred met (or N/A), but Notes too low; "Save up" hint
 *
 * Items have no Cred gate — they're available to anyone with Notes.
 * Items also persist as a count in inventory rather than a boolean
 * owned flag, so the row keeps showing "BUY (×3)" after each purchase.
 *
 * The shop is decoupled from any specific scene — the world map opens
 * it, but a future shop_zone tile in Music Plaza could too. It manages
 * its own DOM lifecycle through show()/hide() and routes input via the
 * EventBus subscription so it composes with whatever scene is hosting.
 */

/** @typedef {'islands' | 'items'} ShopTab */

class ShopUI {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unsubs = [];
  /** @type {(() => void) | null} */
  #onClose = null;
  /** @type {ShopTab} */
  #tab = 'islands';
  /** @type {string[]} */
  #catalogIds = [];
  /** @type {number} */
  #selected = 0;
  /** @type {string} */
  #flashMessage = '';
  /** @type {ReturnType<typeof setTimeout> | null} */
  #flashTimer = null;

  /** @param {() => void} [onClose] */
  show(onClose) {
    if (this.#root) return;
    this.#onClose = onClose ?? null;
    this.#tab = 'islands';
    this.#rebuildCatalog();

    this.#root = this.#buildOverlay();
    document.body.appendChild(this.#root);
    this.#render();

    this.#unsubs.push(
      eventBus.on('input.keyDown', (p) => this.#onKey(p)),
      // Re-render on any state change so cred/notes/owned/inventory updates reflect.
      eventBus.on('stateChanged', () => this.#render())
    );
  }

  hide() {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    if (this.#flashTimer) {
      clearTimeout(this.#flashTimer);
      this.#flashTimer = null;
    }
    this.#root?.remove();
    this.#root = null;
    this.#onClose = null;
  }

  /** @param {{ code: string }} payload */
  #onKey(payload) {
    if (!this.#root || !payload) return;
    switch (payload.code) {
      case 'ArrowUp':
      case 'KeyW':
        if (this.#catalogIds.length > 0) {
          this.#selected =
            (this.#selected - 1 + this.#catalogIds.length) % this.#catalogIds.length;
          this.#render();
        }
        break;
      case 'ArrowDown':
      case 'KeyS':
        if (this.#catalogIds.length > 0) {
          this.#selected = (this.#selected + 1) % this.#catalogIds.length;
          this.#render();
        }
        break;
      case 'ArrowLeft':
      case 'BracketLeft':
        this.#switchTab(this.#tab === 'items' ? 'islands' : 'items');
        break;
      case 'ArrowRight':
      case 'BracketRight':
      case 'Tab':
        this.#switchTab(this.#tab === 'islands' ? 'items' : 'islands');
        break;
      case 'Enter':
      case 'KeyZ':
        this.#tryPurchase();
        break;
      case 'Escape':
      case 'KeyB':
        this.#close();
        break;
      default:
        break;
    }
  }

  /** @param {ShopTab} next */
  #switchTab(next) {
    if (this.#tab === next) return;
    this.#tab = next;
    this.#rebuildCatalog();
    this.#render();
  }

  #rebuildCatalog() {
    if (this.#tab === 'islands') {
      const cfg = /** @type {Record<string, any>} */ (getConfig('islands'));
      // Sort by credRequired so the player reads the catalog top-down
      // as a progression ladder rather than alphabetical noise.
      this.#catalogIds = Object.keys(cfg).sort((a, b) => {
        const ca = cfg[a].credRequired ?? 0;
        const cb = cfg[b].credRequired ?? 0;
        if (ca !== cb) return ca - cb;
        return (cfg[a].price ?? 0) - (cfg[b].price ?? 0);
      });
    } else {
      const cfg = /** @type {Record<string, any>} */ (getConfig('items'));
      // Sort items by buy price so cheap consumables anchor the top.
      this.#catalogIds = Object.keys(cfg).sort(
        (a, b) => (cfg[a].buy ?? 0) - (cfg[b].buy ?? 0)
      );
    }
    this.#selected = 0;
  }

  #close() {
    const cb = this.#onClose;
    this.hide();
    cb?.();
  }

  #tryPurchase() {
    const id = this.#catalogIds[this.#selected];
    if (!id) return;
    if (this.#tab === 'islands') {
      const cfg = /** @type {Record<string, any>} */ (getConfig('islands'));
      const def = cfg[id];
      if (!def) return;
      const status = this.#islandStatusFor({ ...def, id });
      if (status !== 'available') {
        this.#flashRow();
        return;
      }
      dispatch({ type: 'PURCHASE_ISLAND', islandId: id, price: def.price ?? 0 });
      eventBus.emit('shop.islandPurchased', { islandId: id, price: def.price ?? 0 });
    } else {
      const cfg = /** @type {Record<string, any>} */ (getConfig('items'));
      const def = cfg[id];
      if (!def) return;
      if (getState().manager.notes < (def.buy ?? 0)) {
        this.#flashRow();
        return;
      }
      dispatch({ type: 'PURCHASE_ITEM', itemId: id, price: def.buy ?? 0 });
      eventBus.emit('shop.itemPurchased', { itemId: id, price: def.buy ?? 0 });
      this.#flash(`Bought ${def.name}.`);
    }
  }

  #flashRow() {
    const row = this.#root?.querySelector(`[data-idx="${this.#selected}"]`);
    if (!row) return;
    row.classList.remove('flash');
    void /** @type {HTMLElement} */ (row).offsetWidth;
    row.classList.add('flash');
  }

  /** @param {string} text */
  #flash(text) {
    this.#flashMessage = text;
    this.#render();
    if (this.#flashTimer) clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => {
      this.#flashMessage = '';
      this.#render();
      this.#flashTimer = null;
    }, 1600);
  }

  /**
   * @param {{ id?: string, price?: number, credRequired?: number }} def
   * @returns {'owned' | 'available' | 'poor' | 'locked'}
   */
  #islandStatusFor(def) {
    const s = getState();
    if (def.id && s.world.ownedIslands.includes(def.id)) return 'owned';
    if (s.manager.credibility < (def.credRequired ?? 1)) return 'locked';
    if (s.manager.notes < (def.price ?? 0)) return 'poor';
    return 'available';
  }

  /**
   * @param {{ buy?: number }} def
   * @returns {'available' | 'poor'}
   */
  #itemStatusFor(def) {
    const s = getState();
    if (s.manager.notes < (def.buy ?? 0)) return 'poor';
    return 'available';
  }

  #render() {
    if (!this.#root) return;
    const list = this.#root.querySelector('[data-bind="list"]');
    const summary = this.#root.querySelector('[data-bind="summary"]');
    const title = this.#root.querySelector('[data-bind="title"]');
    const flash = this.#root.querySelector('[data-bind="flash"]');
    if (!list || !summary || !title) return;

    const s = getState();

    title.textContent =
      this.#tab === 'islands' ? 'SHOP — Islands' : 'SHOP — Items';

    const next = expToNextCred(s.manager.credibility);
    summary.textContent =
      `Notes ${s.manager.notes.toLocaleString()}  ·  ` +
      `Cred ${s.manager.credibility}  ·  ` +
      `EXP ${s.manager.exp.toLocaleString()} / ${next.toLocaleString()}`;

    if (flash) {
      flash.textContent = this.#flashMessage;
      flash.classList.toggle('show', !!this.#flashMessage);
    }

    // Tab indicators
    const tabIslands = this.#root.querySelector('[data-tab="islands"]');
    const tabItems = this.#root.querySelector('[data-tab="items"]');
    if (tabIslands) tabIslands.classList.toggle('active', this.#tab === 'islands');
    if (tabItems) tabItems.classList.toggle('active', this.#tab === 'items');

    if (this.#tab === 'islands') {
      list.innerHTML = this.#renderIslandsList();
    } else {
      list.innerHTML = this.#renderItemsList();
    }
  }

  #renderIslandsList() {
    const cfg = /** @type {Record<string, any>} */ (getConfig('islands'));
    return this.#catalogIds
      .map((id, idx) => {
        const def = { ...cfg[id], id };
        const status = this.#islandStatusFor(def);
        return /* html */ `
          <div class="row ${idx === this.#selected ? 'active' : ''} ${status}" data-idx="${idx}">
            <div class="left">
              <div class="name">${def.name}</div>
              <div class="meta">
                <span class="rarity ${def.rarity}">${def.rarity}</span>
                <span class="bio">${def.summary ?? def.biome ?? ''}</span>
              </div>
            </div>
            <div class="right">
              <div class="price">${def.price > 0 ? `${def.price.toLocaleString()} N` : 'FREE'}</div>
              <div class="req">Cred ${def.credRequired ?? 1}</div>
              <div class="status">${this.#islandStatusLabel(status, def)}</div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  #renderItemsList() {
    const cfg = /** @type {Record<string, any>} */ (getConfig('items'));
    const inv = getState().inventory;
    return this.#catalogIds
      .map((id, idx) => {
        const def = cfg[id];
        if (!def) return '';
        const status = this.#itemStatusFor(def);
        const owned = inv[id] ?? 0;
        const ownedBadge = owned > 0 ? `<span class="own-badge">×${owned}</span>` : '';
        return /* html */ `
          <div class="row ${idx === this.#selected ? 'active' : ''} ${status}" data-idx="${idx}">
            <div class="left">
              <div class="name">${def.name} ${ownedBadge}</div>
              <div class="meta">
                <span class="bio">${def.summary ?? ''}</span>
              </div>
            </div>
            <div class="right">
              <div class="price">${(def.buy ?? 0).toLocaleString()} N</div>
              <div class="req">${def.duration === 'battle' ? 'Battle buff' : def.duration === 'instant' ? 'Instant' : ''}</div>
              <div class="status">${this.#itemStatusLabel(status, def)}</div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  /**
   * @param {'owned' | 'available' | 'poor' | 'locked'} status
   * @param {{ credRequired?: number, price?: number }} def
   */
  #islandStatusLabel(status, def) {
    switch (status) {
      case 'owned':
        return 'OWNED';
      case 'available':
        return 'BUY';
      case 'poor':
        return `NEED ${(def.price ?? 0) - getState().manager.notes} MORE`;
      case 'locked':
      default:
        return `LOCKED · CRED ${def.credRequired}`;
    }
  }

  /**
   * @param {'available' | 'poor'} status
   * @param {{ buy?: number }} def
   */
  #itemStatusLabel(status, def) {
    if (status === 'available') return 'BUY';
    return `NEED ${(def.buy ?? 0) - getState().manager.notes} MORE`;
  }

  /** @returns {HTMLElement} */
  #buildOverlay() {
    const root = document.createElement('div');
    root.id = 'shop-overlay';
    root.innerHTML = /* html */ `
      <style>
        #shop-overlay {
          position: fixed; inset: 0; z-index: 12;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2;
          background: rgba(8, 10, 16, 0.78);
          backdrop-filter: blur(2px);
          display: flex; flex-direction: column; align-items: center;
          padding: 6vh 24px;
        }
        #shop-overlay .title {
          font-size: 28px; font-weight: 900; letter-spacing: 4px;
          color: #ffd884;
        }
        #shop-overlay .subtitle {
          font-size: 12px; letter-spacing: 2.5px; color: #8a96a4;
          margin-top: 4px; text-transform: uppercase;
        }
        #shop-overlay .summary {
          margin-top: 14px; font-size: 14px; color: #c8d4e0;
          letter-spacing: 1px;
        }
        #shop-overlay .tabs {
          margin-top: 18px;
          display: flex; gap: 6px;
        }
        #shop-overlay .tab {
          padding: 8px 18px;
          background: rgba(14, 18, 26, 0.92);
          border: 1px solid #2a3340; border-radius: 6px;
          font-size: 12px; letter-spacing: 2px; text-transform: uppercase;
          color: #8a96a4; cursor: default;
          transition: all 140ms ease-out;
        }
        #shop-overlay .tab.active {
          color: #ffd884;
          border-color: #ffb949;
          box-shadow: 0 0 10px rgba(255,185,73,0.30);
        }
        #shop-overlay .flash {
          margin-top: 10px; font-size: 13px;
          color: #ffd884; letter-spacing: 1.2px;
          opacity: 0; transition: opacity 140ms ease-out;
          min-height: 16px;
        }
        #shop-overlay .flash.show { opacity: 1; }
        #shop-overlay .list {
          margin-top: 14px;
          width: 100%; max-width: 720px;
          display: flex; flex-direction: column; gap: 10px;
          max-height: 60vh; overflow-y: auto;
        }
        #shop-overlay .row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 12px 16px;
          background: rgba(14, 18, 26, 0.92);
          border: 1px solid #2a3340; border-radius: 8px;
          transition: border-color 140ms ease-out, transform 140ms ease-out;
        }
        #shop-overlay .row.active {
          border-color: #ffb949;
          box-shadow: 0 0 14px rgba(255,185,73,0.35);
          transform: translateX(2px);
        }
        #shop-overlay .row.owned     { opacity: 0.55; }
        #shop-overlay .row.locked    { opacity: 0.55; }
        #shop-overlay .row.poor      { opacity: 0.85; }
        #shop-overlay .row.available { }
        #shop-overlay .row.flash {
          animation: shop-flash 360ms ease-out 1;
        }
        @keyframes shop-flash {
          0%   { background: rgba(232,90,90,0.35); }
          100% { background: rgba(14,18,26,0.92); }
        }
        #shop-overlay .name {
          font-size: 17px; font-weight: 700; color: #ffd884;
          letter-spacing: 1px;
        }
        #shop-overlay .own-badge {
          margin-left: 6px;
          font-size: 11px; color: #6ec1ff;
          letter-spacing: 1px;
          padding: 1px 6px;
          background: rgba(110,193,255,0.10);
          border-radius: 3px;
        }
        #shop-overlay .meta {
          font-size: 11px; color: #8a96a4; margin-top: 4px;
          letter-spacing: 1px;
          display: flex; gap: 10px; align-items: center;
        }
        #shop-overlay .rarity {
          padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
          background: rgba(255,255,255,0.06);
        }
        #shop-overlay .rarity.shop      { color: #ffd884; }
        #shop-overlay .rarity.common    { color: #b0bec5; }
        #shop-overlay .rarity.uncommon  { color: #8acf8a; }
        #shop-overlay .rarity.rare      { color: #6ec1ff; }
        #shop-overlay .rarity.epic      { color: #c77dff; }
        #shop-overlay .rarity.legendary { color: #ffd166; }
        #shop-overlay .right {
          text-align: right;
        }
        #shop-overlay .price {
          font-size: 14px; font-weight: 700; color: #f0e7ce;
        }
        #shop-overlay .req {
          font-size: 11px; color: #8a96a4; margin-top: 2px;
          letter-spacing: 1px;
        }
        #shop-overlay .status {
          font-size: 11px; font-weight: 700; margin-top: 4px;
          letter-spacing: 2px;
        }
        #shop-overlay .row.available .status { color: #6ec1ff; }
        #shop-overlay .row.owned .status     { color: #8acf8a; }
        #shop-overlay .row.locked .status    { color: #c98a8a; }
        #shop-overlay .row.poor .status      { color: #c98a8a; }
        #shop-overlay .controls {
          margin-top: 22px; font-size: 12px; color: #8a96a4;
          letter-spacing: 1.5px;
        }
        #shop-overlay .controls kbd {
          display: inline-block; padding: 2px 6px;
          border: 1px solid #3a4756; border-radius: 4px;
          color: #e8edf2; background: rgba(255,255,255,0.04);
          font-family: inherit; font-size: 11px;
        }
      </style>
      <div class="title" data-bind="title">SHOP — Islands</div>
      <div class="subtitle">Build out your tour. Stock the band fridge.</div>
      <div class="summary" data-bind="summary"></div>
      <div class="tabs">
        <div class="tab" data-tab="islands">Islands</div>
        <div class="tab" data-tab="items">Items</div>
      </div>
      <div class="flash" data-bind="flash"></div>
      <div class="list" data-bind="list"></div>
      <div class="controls">
        <kbd>↑</kbd>/<kbd>↓</kbd> select &nbsp;·&nbsp;
        <kbd>←</kbd>/<kbd>→</kbd> tab &nbsp;·&nbsp;
        <kbd>Enter</kbd> buy &nbsp;·&nbsp;
        <kbd>B</kbd>/<kbd>Esc</kbd> close
      </div>
    `;
    return root;
  }
}

export const shopUI = new ShopUI();
