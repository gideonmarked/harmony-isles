// @ts-check

import { eventBus } from '../engine/eventBus.js';
import { getState, expToNextCred } from '../engine/gameState.js';

/**
 * Explore HUD — top-left island name + step counter, bottom-left
 * control hints, and the rarity-tinted '!' encounter telegraph
 * (design doc §12.4).
 *
 * The telegraph holds for ~900ms (`commonHoldMs`) before the scene
 * transitions to the battle so the player has time to register the
 * encounter — exact durations per §12.4 vary by rarity (common:
 * 600ms, rare: 800ms, epic: 1.2s, legendary: 2s). The scene drives
 * the timing; the HUD just renders.
 */
class ExploreHud {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unsubs = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  #telegraphTimer = null;

  show() {
    if (this.#root) return;

    const root = document.createElement('div');
    root.id = 'explore-hud';
    root.innerHTML = /* html */ `
      <style>
        #explore-hud {
          position: fixed; inset: 0; pointer-events: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; z-index: 9;
        }
        #explore-hud .island-info {
          position: absolute; top: 16px; left: 16px;
          background: rgba(14, 18, 26, 0.78);
          border: 1px solid #2a3340; border-radius: 6px;
          padding: 10px 14px;
          min-width: 180px;
        }
        #explore-hud .island-info .label {
          font-size: 10px; letter-spacing: 2.5px; color: #8a96a4;
          text-transform: uppercase;
        }
        #explore-hud .island-info .name {
          font-size: 16px; font-weight: 700; color: #ffd884;
          letter-spacing: 1.5px; margin-top: 2px;
        }
        #explore-hud .island-info .rarity {
          font-size: 11px; letter-spacing: 1.5px; margin-top: 2px;
          text-transform: uppercase;
        }
        #explore-hud .rarity.common    { color: #b0bec5; }
        #explore-hud .rarity.uncommon  { color: #8acf8a; }
        #explore-hud .rarity.rare      { color: #6ec1ff; }
        #explore-hud .rarity.epic      { color: #c77dff; }
        #explore-hud .rarity.legendary { color: #ffd166; }
        #explore-hud .island-info .steps {
          font-size: 11px; color: #8a96a4; margin-top: 6px;
        }
        #explore-hud .island-info .manager {
          font-size: 11px; color: #c8d4e0; margin-top: 6px;
          letter-spacing: 0.5px;
        }
        #explore-hud .island-info .manager .exp { color: #6ec1ff; }

        #explore-hud .controls {
          position: absolute; bottom: 16px; left: 16px;
          background: rgba(14, 18, 26, 0.78);
          border: 1px solid #2a3340; border-radius: 6px;
          padding: 10px 14px;
          font-size: 12px; color: #c8d4e0; line-height: 1.7;
        }
        #explore-hud .controls kbd {
          display: inline-block; padding: 1px 6px;
          border: 1px solid #3a4756; border-radius: 4px;
          color: #e8edf2; background: rgba(255,255,255,0.04);
          font-family: inherit; font-size: 11px; min-width: 18px; text-align: center;
        }

        #explore-hud .telegraph {
          position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%) scale(0.6);
          font-size: 96px; font-weight: 900; letter-spacing: 6px;
          opacity: 0;
          transition: opacity 120ms ease-out, transform 220ms cubic-bezier(.2, 1.6, .4, 1);
          text-shadow: 0 0 18px currentColor;
        }
        #explore-hud .telegraph.show {
          opacity: 1; transform: translate(-50%, -50%) scale(1);
        }
        #explore-hud .telegraph.common    { color: #ffffff; }
        #explore-hud .telegraph.rare      { color: #6ec1ff; }
        #explore-hud .telegraph.epic      { color: #c77dff; }
        #explore-hud .telegraph.legendary { color: #ffd166; }

        #explore-hud .vignette {
          position: absolute; inset: 0;
          opacity: 0; transition: opacity 240ms ease-out;
          background: radial-gradient(circle at 50% 40%, rgba(110,193,255,0.18), transparent 60%);
        }
        #explore-hud .vignette.show { opacity: 1; }
      </style>
      <div class="island-info">
        <div class="label">Island</div>
        <div class="name" data-bind="islandName">—</div>
        <div class="rarity common" data-bind="islandRarity">common</div>
        <div class="steps" data-bind="steps">Steps: 0</div>
        <div class="manager" data-bind="manager">Cred 1 · EXP 0 / 80 · 0 N</div>
      </div>
      <div class="controls">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk</div>
        <div><kbd>M</kbd>/<kbd>Esc</kbd> world map</div>
      </div>
      <div class="vignette" data-bind="vignette"></div>
      <div class="telegraph" data-bind="telegraph">!</div>
    `;
    document.body.appendChild(root);
    this.#root = root;

    // Cheap step counter — useful for tuning encounter rates while
    // playtesting and as a "the world is reacting to you" signal.
    let steps = 0;
    this.#unsubs.push(
      eventBus.on('player.stepped', () => {
        steps += 1;
        const el = this.#qs('steps');
        if (el) el.textContent = `Steps: ${steps}`;
      })
    );

    // Manager line: refreshed on any state change so EXP / Cred /
    // Notes stay accurate after battle rewards land.
    const renderManager = () => {
      const el = this.#qs('manager');
      if (!el) return;
      const m = getState().manager;
      const next = expToNextCred(m.credibility);
      el.innerHTML =
        `Cred ${m.credibility} · ` +
        `<span class="exp">EXP ${m.exp.toLocaleString()} / ${next.toLocaleString()}</span> · ` +
        `${m.notes.toLocaleString()} N`;
    };
    renderManager();
    this.#unsubs.push(eventBus.on('stateChanged', renderManager));
  }

  hide() {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    if (this.#telegraphTimer) {
      clearTimeout(this.#telegraphTimer);
      this.#telegraphTimer = null;
    }
    this.#root?.remove();
    this.#root = null;
  }

  /**
   * @param {{ name: string, rarity: string }} info
   */
  setIsland(info) {
    const name = this.#qs('islandName');
    const rarity = this.#qs('islandRarity');
    if (name) name.textContent = info.name;
    if (rarity) {
      rarity.textContent = info.rarity;
      rarity.className = `rarity ${info.rarity}`;
    }
  }

  /**
   * Show the rarity-tinted '!' splash. Auto-hides after `holdMs`.
   *
   * @param {'common' | 'rare' | 'epic' | 'legendary'} rarity
   * @param {number} holdMs
   */
  showTelegraph(rarity, holdMs) {
    const tele = this.#qs('telegraph');
    const vig = this.#qs('vignette');
    if (!tele || !vig) return;

    tele.textContent =
      rarity === 'legendary' ? '!!!' : rarity === 'epic' ? '!!' : '!';
    tele.className = `telegraph ${rarity}`;
    // Re-trigger the entrance transition.
    void /** @type {HTMLElement} */ (tele).offsetWidth;
    tele.classList.add('show');
    vig.classList.add('show');

    if (this.#telegraphTimer) clearTimeout(this.#telegraphTimer);
    this.#telegraphTimer = setTimeout(() => {
      tele.classList.remove('show');
      vig.classList.remove('show');
      this.#telegraphTimer = null;
    }, holdMs);
  }

  /** @param {string} bind @returns {HTMLElement | null} */
  #qs(bind) {
    return /** @type {HTMLElement | null} */ (
      this.#root?.querySelector(`[data-bind="${bind}"]`) ?? null
    );
  }
}

export const exploreHud = new ExploreHud();
