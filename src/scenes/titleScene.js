// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { dispatch } from '../engine/gameState.js';

/**
 * Title scene — game logo + Manager Style picker (design doc §8.1).
 *
 * Flow per §32: Title → choose Manager Style → battle. The slice skips
 * profile naming and starter selection (single character for now); the
 * style choice is the only meaningful decision before play.
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
  /** @type {import('../engine/gameState.js').ManagerStyle[]} */
  let styles = [];
  let selected = 0;

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
      <div class="picker-label">Choose a Manager Style</div>
      <div class="styles" data-bind="styles"></div>
      <div class="hint">
        <kbd>1</kbd>–<kbd>5</kbd> select &nbsp;·&nbsp; <kbd>←</kbd>/<kbd>→</kbd> move &nbsp;·&nbsp; <kbd>Enter</kbd> or <kbd>Z</kbd> start
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function renderCards() {
    if (!overlay) return;
    const container = overlay.querySelector('[data-bind="styles"]');
    if (!container) return;
    container.innerHTML = styles
      .map(
        (s, i) => /* html */ `
        <div class="style ${i === selected ? 'active' : ''}" data-idx="${i}">
          <div>
            <span class="name">${s.name}</span>
            <span class="key">${i + 1}</span>
          </div>
          <div class="theme">${s.theme}</div>
          <div class="summary">${s.summary}</div>
          <div class="tradeoff">${s.tradeoff}</div>
        </div>`
      )
      .join('');
  }

  function start() {
    const style = styles[selected];
    if (!style) return;
    dispatch({ type: 'SELECT_MANAGER_STYLE', style });
    sceneManager.transition('battle');
  }

  return {
    id: 'title',

    enter(ctx) {
      group = new THREE.Group();
      // Subtle backdrop block — keeps the iso scene from looking empty
      // while DOM overlay carries the foreground content.
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
      selected = 0;

      overlay = buildOverlay();
      renderCards();

      unsubscribe = eventBus.on(
        'input.keyDown',
        /** @param {{ code: string }} payload */
        (payload) => {
          if (!payload) return;
          switch (payload.code) {
            case 'Digit1':
            case 'Digit2':
            case 'Digit3':
            case 'Digit4':
            case 'Digit5': {
              const idx = Number(payload.code.slice(-1)) - 1;
              if (idx < styles.length) {
                selected = idx;
                renderCards();
                start();
              }
              break;
            }
            case 'ArrowLeft':
              selected = (selected - 1 + styles.length) % styles.length;
              renderCards();
              break;
            case 'ArrowRight':
              selected = (selected + 1) % styles.length;
              renderCards();
              break;
            case 'Enter':
            case 'KeyZ':
              start();
              break;
            default:
              break;
          }
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
