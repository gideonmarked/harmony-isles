// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { dispatch } from '../engine/gameState.js';
import { saveSystem, MAX_SLOTS } from '../engine/saveSystem.js';

/**
 * Title scene — two views in sequence:
 *
 *   1. **Slot picker.** 3 cards, one per LocalStorage save slot.
 *      Each shows either "Continue" (with Cred / Notes / Captures
 *      summary) or "New Game" if empty. Picking a saved slot
 *      hydrates state and drops the player straight into the world
 *      map. Picking an empty slot advances to the Style view.
 *
 *   2. **Manager Style picker.** The original 5-archetype picker,
 *      shown only on a New Game. Picking a style writes the freshly
 *      seeded save into the active slot and transitions to world map.
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const titleScene = (() => {
  /** @type {THREE.Group | null} */
  let group = null;
  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /** @type {'slots' | 'styles'} */
  let view = 'slots';
  /** @type {ReturnType<typeof saveSystem.listSlots>} */
  let slotInfo = [];
  /** @type {number} */
  let slotSelected = 0;
  /** @type {import('../engine/gameState.js').ManagerStyle[]} */
  let styles = [];
  /** @type {number} */
  let styleSelected = 0;

  function buildOverlay() {
    const root = document.createElement('div');
    root.id = 'title-overlay';
    root.innerHTML = /* html */ `
      <style>
        #title-overlay {
          position: fixed; inset: 0; pointer-events: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2;
          display: flex; flex-direction: column; align-items: center;
          justify-content: flex-start; padding-top: 8vh; gap: 24px;
        }
        #title-overlay .game-title {
          font-size: 48px; font-weight: 900; letter-spacing: 6px;
          color: #fffae0;
          text-shadow: 0 0 18px rgba(255, 200, 110, 0.45), 0 0 4px rgba(255, 255, 255, 0.5);
        }
        #title-overlay .subtitle {
          font-size: 13px; letter-spacing: 3px; color: #8a96a4;
          text-transform: uppercase;
        }
        #title-overlay .picker-label {
          font-size: 14px; letter-spacing: 2px; color: #c8d4e0;
          margin-top: 12px; text-transform: uppercase;
        }

        /* Slots */
        #title-overlay .slots {
          display: flex; gap: 14px; flex-wrap: wrap; justify-content: center;
          max-width: 900px; padding: 0 24px;
        }
        #title-overlay .slot {
          width: 240px; min-height: 130px;
          padding: 14px 16px;
          background: rgba(14, 18, 26, 0.85);
          border: 1px solid #2a3340; border-radius: 8px;
          transition: border-color 180ms ease-out, transform 180ms ease-out, box-shadow 180ms ease-out;
        }
        #title-overlay .slot.active {
          border-color: #ffb949;
          box-shadow: 0 0 16px rgba(255, 185, 73, 0.45);
          transform: translateY(-3px);
        }
        #title-overlay .slot .head {
          display: flex; justify-content: space-between; align-items: baseline;
        }
        #title-overlay .slot .label {
          font-size: 13px; letter-spacing: 2px; color: #8a96a4;
          text-transform: uppercase;
        }
        #title-overlay .slot .key {
          font-weight: 800; color: #6ec1ff; font-size: 14px;
        }
        #title-overlay .slot .name {
          margin-top: 6px;
          font-size: 17px; font-weight: 700; letter-spacing: 1px;
          color: #ffd884;
        }
        #title-overlay .slot .meta {
          margin-top: 8px; font-size: 12px; color: #c8d4e0; line-height: 1.55;
        }
        #title-overlay .slot .meta .row { display: flex; justify-content: space-between; }
        #title-overlay .slot .meta .row span:first-child { color: #8a96a4; }
        #title-overlay .slot .empty { color: #8a96a4; font-size: 12px; }
        #title-overlay .slot.empty .name { color: #8acf8a; }

        /* Styles (original picker) */
        #title-overlay .styles {
          display: flex; gap: 14px; flex-wrap: wrap; justify-content: center;
          max-width: 1100px; padding: 0 24px;
        }
        #title-overlay .style {
          width: 200px;
          padding: 14px 14px 16px;
          background: rgba(14, 18, 26, 0.85);
          border: 1px solid #2a3340;
          border-radius: 8px;
          transition: border-color 180ms ease-out, transform 180ms ease-out, box-shadow 180ms ease-out;
        }
        #title-overlay .style.active {
          border-color: #ffb949;
          box-shadow: 0 0 16px rgba(255, 185, 73, 0.45);
          transform: translateY(-3px);
        }
        #title-overlay .style .name {
          font-size: 16px; font-weight: 700; letter-spacing: 1px;
          color: #ffd884; margin-bottom: 2px;
        }
        #title-overlay .style .theme {
          font-size: 11px; letter-spacing: 1.5px; color: #8a96a4;
          text-transform: uppercase; margin-bottom: 10px;
        }
        #title-overlay .style .summary { font-size: 12.5px; line-height: 1.4; color: #c8d4e0; }
        #title-overlay .style .tradeoff { font-size: 12px; line-height: 1.4; color: #c98a8a; margin-top: 6px; }
        #title-overlay .style .key {
          float: right; font-weight: 800; color: #6ec1ff; font-size: 16px; letter-spacing: 1px;
        }

        #title-overlay .hint {
          font-size: 12px; color: #8a96a4; margin-top: 18px; letter-spacing: 1px;
        }
        #title-overlay .hint kbd {
          display: inline-block; padding: 2px 6px;
          border: 1px solid #3a4756; border-radius: 4px;
          color: #e8edf2; background: rgba(255,255,255,0.04);
          font-family: inherit; font-size: 11px;
        }
      </style>
      <div class="game-title">HARMONY ISLES</div>
      <div class="subtitle">An isometric pixel-art rhythm RPG</div>
      <div class="picker-label" data-bind="label"></div>
      <div data-bind="body"></div>
      <div class="hint" data-bind="hint"></div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function renderSlots() {
    if (!overlay) return;
    const label = overlay.querySelector('[data-bind="label"]');
    const body = overlay.querySelector('[data-bind="body"]');
    const hint = overlay.querySelector('[data-bind="hint"]');
    if (!label || !body || !hint) return;

    label.textContent = 'Pick a Profile';
    slotInfo = saveSystem.listSlots();

    body.outerHTML = /* html */ `
      <div class="slots" data-bind="body">
        ${slotInfo
          .map((s, i) => {
            const isActive = i === slotSelected;
            if (!s) {
              return /* html */ `
                <div class="slot ${isActive ? 'active' : ''} empty" data-idx="${i}">
                  <div class="head">
                    <span class="label">Slot ${i + 1}</span>
                    <span class="key">${i + 1}</span>
                  </div>
                  <div class="name">New Game</div>
                  <div class="meta empty">— start fresh —</div>
                </div>`;
            }
            return /* html */ `
              <div class="slot ${isActive ? 'active' : ''}" data-idx="${i}">
                <div class="head">
                  <span class="label">Slot ${i + 1} · Continue</span>
                  <span class="key">${i + 1}</span>
                </div>
                <div class="name">${s.profileName}</div>
                <div class="meta">
                  <div class="row"><span>Cred</span><span>${s.credibility}</span></div>
                  <div class="row"><span>Notes</span><span>${s.notes.toLocaleString()}</span></div>
                  <div class="row"><span>EXP</span><span>${s.exp.toLocaleString()}</span></div>
                  <div class="row"><span>Owned</span><span>${s.owned}</span></div>
                  <div class="row"><span>Captures</span><span>${s.captures}</span></div>
                </div>
              </div>`;
          })
          .join('')}
      </div>
    `;

    hint.innerHTML = /* html */ `
      <kbd>1</kbd>–<kbd>${MAX_SLOTS}</kbd> select &nbsp;·&nbsp;
      <kbd>←</kbd>/<kbd>→</kbd> move &nbsp;·&nbsp;
      <kbd>Enter</kbd>/<kbd>Z</kbd> choose &nbsp;·&nbsp;
      <kbd>Shift</kbd>+<kbd>Del</kbd> wipe slot
    `;
  }

  function renderStyles() {
    if (!overlay) return;
    const label = overlay.querySelector('[data-bind="label"]');
    const body = overlay.querySelector('[data-bind="body"]');
    const hint = overlay.querySelector('[data-bind="hint"]');
    if (!label || !body || !hint) return;

    label.textContent = 'Choose a Manager Style';
    body.outerHTML = /* html */ `
      <div class="styles" data-bind="body">
        ${styles
          .map(
            (s, i) => /* html */ `
            <div class="style ${i === styleSelected ? 'active' : ''}" data-idx="${i}">
              <div>
                <span class="name">${s.name}</span>
                <span class="key">${i + 1}</span>
              </div>
              <div class="theme">${s.theme}</div>
              <div class="summary">${s.summary}</div>
              <div class="tradeoff">${s.tradeoff}</div>
            </div>`
          )
          .join('')}
      </div>
    `;
    hint.innerHTML = /* html */ `
      <kbd>1</kbd>–<kbd>5</kbd> select &nbsp;·&nbsp;
      <kbd>←</kbd>/<kbd>→</kbd> move &nbsp;·&nbsp;
      <kbd>Enter</kbd>/<kbd>Z</kbd> start &nbsp;·&nbsp;
      <kbd>Esc</kbd> back
    `;
  }

  function chooseSlot() {
    const info = slotInfo[slotSelected];
    if (info) {
      // Existing save → load and jump to world map.
      saveSystem.loadSlot(slotSelected);
      sceneManager.transition('worldMap');
    } else {
      // Empty slot → fresh New Game; pick a manager style next.
      saveSystem.setActiveSlot(slotSelected);
      saveSystem.startNewGame();
      view = 'styles';
      styleSelected = 0;
      renderStyles();
    }
  }

  function startWithStyle() {
    const style = styles[styleSelected];
    if (!style) return;
    dispatch({ type: 'SELECT_MANAGER_STYLE', style });
    saveSystem.saveNow();
    sceneManager.transition('worldMap');
  }

  /** @param {{ code: string, shiftKey?: boolean }} payload */
  function onKeySlots(payload) {
    if (payload.shiftKey && payload.code === 'Delete') {
      saveSystem.deleteSlot(slotSelected);
      renderSlots();
      return;
    }
    switch (payload.code) {
      case 'Digit1':
      case 'Digit2':
      case 'Digit3': {
        const idx = Number(payload.code.slice(-1)) - 1;
        if (idx < MAX_SLOTS) {
          slotSelected = idx;
          renderSlots();
          chooseSlot();
        }
        break;
      }
      case 'ArrowLeft':
        slotSelected = (slotSelected - 1 + MAX_SLOTS) % MAX_SLOTS;
        renderSlots();
        break;
      case 'ArrowRight':
        slotSelected = (slotSelected + 1) % MAX_SLOTS;
        renderSlots();
        break;
      case 'Enter':
      case 'KeyZ':
        chooseSlot();
        break;
      default:
        break;
    }
  }

  /** @param {{ code: string }} payload */
  function onKeyStyles(payload) {
    switch (payload.code) {
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
      case 'Digit5': {
        const idx = Number(payload.code.slice(-1)) - 1;
        if (idx < styles.length) {
          styleSelected = idx;
          renderStyles();
          startWithStyle();
        }
        break;
      }
      case 'ArrowLeft':
        styleSelected = (styleSelected - 1 + styles.length) % styles.length;
        renderStyles();
        break;
      case 'ArrowRight':
        styleSelected = (styleSelected + 1) % styles.length;
        renderStyles();
        break;
      case 'Enter':
      case 'KeyZ':
        startWithStyle();
        break;
      case 'Escape':
        view = 'slots';
        renderSlots();
        break;
      default:
        break;
    }
  }

  return {
    id: 'title',

    enter(ctx) {
      group = new THREE.Group();
      const accent = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.4, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x2a3340 })
      );
      accent.position.set(0, 0.2, 0);
      group.add(accent);
      ctx.scene.add(group);

      try {
        const cfg = /** @type {Record<string, import('../engine/gameState.js').ManagerStyle>} */ (
          getConfig('managerStyles')
        );
        styles = Object.values(cfg);
      } catch (e) {
        console.error('titleScene: managerStyles config missing', e);
        styles = [];
      }

      // If a manager style is already picked (returning from world
      // map via Esc with state already loaded), default to slot
      // picker but pre-select the active slot.
      slotSelected = saveSystem.activeSlot;
      // If the player came back to title with state already loaded
      // and a style chosen, they probably want to pick a different
      // profile — start in slots view regardless.
      view = 'slots';

      overlay = buildOverlay();
      renderSlots();

      unsubscribe = eventBus.on(
        'input.keyDown',
        /** @param {{ code: string, shiftKey?: boolean }} payload */
        (payload) => {
          if (!payload) return;
          if (view === 'slots') onKeySlots(payload);
          else onKeyStyles(payload);
        }
      );
    },

    exit() {
      unsubscribe?.();
      unsubscribe = null;
      overlay?.remove();
      overlay = null;
      if (group?.parent) group.parent.remove(group);
      group = null;
    },
  };
})();

