// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { dispatch, getState, expToNextCred } from '../engine/gameState.js';
import { setCameraIso } from '../engine/renderer.js';
import { rosterUI } from '../ui/rosterUI.js';
import { itemMenu } from '../ui/itemMenu.js';
import { bindAsClick, bindAsKey } from '../util/pointer.js';

/**
 * World Map scene — the player's "tour itinerary" view (design doc
 * §6.1). Lists every island the player owns as a card; the player
 * picks one to enter Explore mode.
 *
 * The full design has draggable bridge connections between islands;
 * the slice ships the simpler picker UI so the purchasing loop is
 * exercisable end-to-end. Bridge placement is a content add over
 * this scene's data model, not a rewrite.
 *
 * Routes:
 *   Enter / Z   → Explore the highlighted island
 *   R           → Open Roster overlay (manage band)
 *   I           → View inventory (read-only)
 *   Esc         → Title
 *
 * The shop is reachable only from inside Music Plaza (handled by
 * exploreScene), so the player has to physically walk into the hub
 * to buy islands or items.
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const worldMapScene = (() => {
  /** @type {THREE.Group | null} */
  let group = null;
  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {(() => void)[]} */
  let unsubs = [];
  /** @type {(() => void)[]} */
  let pointerUnbinds = [];
  /** @type {(() => void)[]} */
  let cardUnbinds = [];
  /** Currently highlighted index into `ownedIds`. */
  let selected = 0;
  /** Snapshot of owned ids each render — re-read whenever state changes. */
  /** @type {string[]} */
  let ownedIds = [];
  /** True while the roster overlay owns input. */
  let rosterOpen = false;
  /** True while the inventory viewer owns input. */
  let inventoryOpen = false;

  function readOwned() {
    const cfg = /** @type {Record<string, any>} */ (getConfig('islands'));
    const owned = getState().world.ownedIslands;
    // Stable order: catalog credRequired, then price (matches shop).
    return [...owned].sort((a, b) => {
      const da = cfg[a]?.credRequired ?? 0;
      const db = cfg[b]?.credRequired ?? 0;
      if (da !== db) return da - db;
      return (cfg[a]?.price ?? 0) - (cfg[b]?.price ?? 0);
    });
  }

  function buildOverlay() {
    const root = document.createElement('div');
    root.id = 'worldmap-overlay';
    root.innerHTML = /* html */ `
      <style>
        #worldmap-overlay {
          position: fixed; inset: 0; pointer-events: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; z-index: 9;
          display: flex; flex-direction: column; align-items: center;
          padding-top: 6vh; gap: 18px;
        }
        #worldmap-overlay .title {
          font-size: 32px; font-weight: 900; letter-spacing: 5px;
          color: #ffd884;
          text-shadow: 0 0 18px rgba(255, 200, 110, 0.35);
        }
        #worldmap-overlay .subtitle {
          font-size: 12px; letter-spacing: 2.5px; color: #8a96a4;
          text-transform: uppercase;
        }
        #worldmap-overlay .summary {
          font-size: 14px; color: #c8d4e0; letter-spacing: 1px;
        }
        #worldmap-overlay .grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px; padding: 0 24px;
          max-width: 980px; width: 100%;
        }
        #worldmap-overlay .card {
          padding: 16px;
          background: rgba(14, 18, 26, 0.88);
          border: 1px solid #2a3340; border-radius: 10px;
          transition: border-color 160ms ease-out, transform 160ms ease-out, box-shadow 160ms ease-out;
        }
        #worldmap-overlay .card.active {
          border-color: #ffb949;
          box-shadow: 0 0 18px rgba(255,185,73,0.45);
          transform: translateY(-3px);
        }
        #worldmap-overlay .card .name {
          font-size: 17px; font-weight: 700; letter-spacing: 1px;
          color: #ffd884;
        }
        #worldmap-overlay .card .rarity {
          display: inline-block; margin-top: 4px; padding: 1px 6px;
          border-radius: 3px; font-size: 11px; letter-spacing: 1.5px;
          background: rgba(255,255,255,0.06); text-transform: uppercase;
        }
        #worldmap-overlay .card .rarity.shop      { color: #ffd884; }
        #worldmap-overlay .card .rarity.common    { color: #b0bec5; }
        #worldmap-overlay .card .rarity.uncommon  { color: #8acf8a; }
        #worldmap-overlay .card .rarity.rare      { color: #6ec1ff; }
        #worldmap-overlay .card .rarity.epic      { color: #c77dff; }
        #worldmap-overlay .card .rarity.legendary { color: #ffd166; }
        #worldmap-overlay .card .summary {
          font-size: 12.5px; line-height: 1.45; color: #c8d4e0;
          margin-top: 8px;
        }
        #worldmap-overlay .card .footer {
          font-size: 11px; color: #8a96a4; margin-top: 10px;
          letter-spacing: 1.5px;
        }
        #worldmap-overlay .card.current .footer { color: #6ec1ff; }
        #worldmap-overlay .controls {
          margin-top: 18px; font-size: 12px; color: #8a96a4;
          letter-spacing: 1.5px;
        }
        #worldmap-overlay .controls kbd {
          display: inline-block; padding: 2px 6px;
          border: 1px solid #3a4756; border-radius: 4px;
          color: #e8edf2; background: rgba(255,255,255,0.04);
          font-family: inherit; font-size: 11px;
        }
        #worldmap-overlay .card {
          cursor: pointer; touch-action: manipulation;
          -webkit-tap-highlight-color: transparent; user-select: none;
        }
        #worldmap-overlay .actions {
          margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;
          justify-content: center;
        }
        #worldmap-overlay .actions button {
          padding: 8px 14px;
          background: rgba(14, 18, 26, 0.85);
          border: 1px solid #3a4756; border-radius: 6px;
          color: #e8edf2; font-family: inherit; font-size: 12px;
          letter-spacing: 1px; cursor: pointer;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        #worldmap-overlay .actions button .key {
          color: #ffd884; font-weight: 700; margin-right: 6px;
        }
        #worldmap-overlay .actions button:active {
          background: rgba(255, 185, 73, 0.15);
          border-color: #ffb949;
        }
        #worldmap-overlay .empty {
          padding: 24px; color: #8a96a4; font-size: 13px; text-align: center;
        }
      </style>
      <div class="title">WORLD MAP</div>
      <div class="subtitle">Pick an island to play</div>
      <div class="summary" data-bind="summary"></div>
      <div class="grid" data-bind="grid"></div>
      <div class="controls">
        <kbd>←</kbd>/<kbd>→</kbd> select &nbsp;·&nbsp;
        <kbd>Enter</kbd>/<kbd>Z</kbd> enter island &nbsp;·&nbsp;
        <kbd>R</kbd> roster &nbsp;·&nbsp;
        <kbd>I</kbd> inventory &nbsp;·&nbsp;
        <kbd>Esc</kbd> title
      </div>
      <div class="actions" data-bind="actions">
        <button data-key="KeyZ"><span class="key">Z</span>Enter</button>
        <button data-key="KeyR"><span class="key">R</span>Roster</button>
        <button data-key="KeyI"><span class="key">I</span>Inventory</button>
        <button data-key="Escape"><span class="key">Esc</span>Title</button>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function render() {
    if (!overlay) return;
    const cfg = /** @type {Record<string, any>} */ (getConfig('islands'));
    const s = getState();

    ownedIds = readOwned();
    if (selected >= ownedIds.length) selected = Math.max(0, ownedIds.length - 1);

    const summary = overlay.querySelector('[data-bind="summary"]');
    if (summary) {
      const next = expToNextCred(s.manager.credibility);
      summary.textContent =
        `Notes ${s.manager.notes.toLocaleString()}  ·  ` +
        `Cred ${s.manager.credibility}  ·  ` +
        `EXP ${s.manager.exp.toLocaleString()} / ${next.toLocaleString()}  ·  ` +
        `Owned ${ownedIds.length}`;
    }

    const grid = overlay.querySelector('[data-bind="grid"]');
    if (!grid) return;
    if (ownedIds.length === 0) {
      grid.innerHTML = '<div class="empty">No islands yet — enter Music Plaza, then press <kbd>B</kbd> inside to shop.</div>';
      return;
    }
    // Cards rebuild per render — drop stale click bindings.
    for (const u of cardUnbinds) u();
    cardUnbinds = [];

    grid.innerHTML = ownedIds
      .map((id, idx) => {
        const def = cfg[id] ?? { name: id, rarity: '—', summary: '' };
        const isCurrent = s.world.currentIslandId === id;
        return /* html */ `
          <div class="card ${idx === selected ? 'active' : ''} ${isCurrent ? 'current' : ''}" data-idx="${idx}">
            <div class="name">${def.name}</div>
            <div class="rarity ${def.rarity}">${def.rarity}</div>
            <div class="summary">${def.summary ?? def.biome ?? ''}</div>
            <div class="footer">${isCurrent ? '· CURRENT ·' : `Cred ${def.credRequired ?? 1}`}</div>
          </div>
        `;
      })
      .join('');

    // Tap selects; tapping the already-selected card enters.
    grid.querySelectorAll('.card[data-idx]').forEach((cardEl) => {
      const idxAttr = cardEl.getAttribute('data-idx');
      const idx = idxAttr ? Number(idxAttr) : -1;
      if (idx < 0) return;
      cardUnbinds.push(
        bindAsClick(/** @type {HTMLElement} */ (cardEl), () => {
          if (idx === selected) {
            enterSelected();
          } else {
            selected = idx;
            render();
          }
        })
      );
    });
  }

  function enterSelected() {
    const id = ownedIds[selected];
    if (!id) return;
    dispatch({ type: 'ENTER_ISLAND', islandId: id });
    sceneManager.transition('explore');
  }

  function openRoster() {
    if (rosterOpen) return;
    rosterOpen = true;
    rosterUI.show(() => {
      rosterOpen = false;
      render();
    });
  }

  function openInventory() {
    if (inventoryOpen) return;
    const items = /** @type {Record<string, any>} */ (getConfig('items'));
    const inv = getState().inventory ?? {};
    const entries = Object.entries(inv)
      .filter(([, c]) => Number(c) > 0)
      .map(([id, count]) => {
        const def = items[id] ?? { name: id, summary: '' };
        return {
          id,
          name: def.name ?? id,
          summary: def.summary ?? '',
          count: Number(count),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    inventoryOpen = true;
    itemMenu.show(
      entries,
      () => {},
      () => {
        inventoryOpen = false;
        render();
      },
      { readOnly: true }
    );
  }

  return {
    id: 'worldMap',

    enter(ctx) {
      // Iso pose for the backdrop accent group looks better than top-down here.
      setCameraIso();

      group = new THREE.Group();
      const accent = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.4, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x2a3340 })
      );
      accent.position.set(0, 0.2, 0);
      group.add(accent);
      ctx.scene.add(group);

      selected = Math.max(
        0,
        readOwned().indexOf(getState().world.currentIslandId)
      );
      overlay = buildOverlay();
      render();

      // Footer buttons mirror the keyboard shortcuts. Cards and the
      // shop hint are rebound on each render() pass.
      overlay.querySelectorAll('.actions button[data-key]').forEach((btn) => {
        const code = btn.getAttribute('data-key');
        if (code) pointerUnbinds.push(
          bindAsKey(/** @type {HTMLElement} */ (btn), code)
        );
      });

      unsubs.push(
        eventBus.on(
          'input.keyDown',
          /** @param {{ code: string }} payload */
          (payload) => {
            if (!payload) return;
            // Inventory is read-only — forward keys to itemMenu so
            // Esc / I closes, then bail.
            if (inventoryOpen) {
              itemMenu.handleKey(payload.code);
              return;
            }
            // Sub-overlays swallow input while open.
            if (rosterOpen) return;
            switch (payload.code) {
              case 'ArrowLeft':
              case 'KeyA':
                if (ownedIds.length > 0) {
                  selected = (selected - 1 + ownedIds.length) % ownedIds.length;
                  render();
                }
                break;
              case 'ArrowRight':
              case 'KeyD':
                if (ownedIds.length > 0) {
                  selected = (selected + 1) % ownedIds.length;
                  render();
                }
                break;
              case 'Enter':
              case 'KeyZ':
                enterSelected();
                break;
              case 'KeyR':
                openRoster();
                break;
              case 'KeyI':
                openInventory();
                break;
              case 'Escape':
                sceneManager.transition('title');
                break;
              default:
                break;
            }
          }
        ),
        // State changes (purchase, cred grant, notes change) re-render.
        eventBus.on('stateChanged', () => {
          if (!rosterOpen && !inventoryOpen) render();
        })
      );
    },

    exit() {
      for (const u of unsubs) u();
      unsubs = [];
      for (const u of pointerUnbinds) u();
      pointerUnbinds = [];
      for (const u of cardUnbinds) u();
      cardUnbinds = [];
      if (rosterOpen) {
        rosterUI.hide();
        rosterOpen = false;
      }
      if (inventoryOpen) {
        itemMenu.hide();
        inventoryOpen = false;
      }
      overlay?.remove();
      overlay = null;
      if (group?.parent) group.parent.remove(group);
      group = null;
    },
  };
})();
