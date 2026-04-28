// @ts-check

import { eventBus } from '../engine/eventBus.js';

/**
 * Battle FX — DOM overlays for the "wow" moments: the Band Performance
 * banner when the limit-break starts, and the result banner on victory
 * or defeat.
 *
 * Lives separate from BattleHud so the HUD's persistent panels (HP,
 * Hype, prompt) and the FX layer's transient announcements have
 * independent lifecycles.
 */
class BattleFx {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unsubs = [];
  /** @type {ReturnType<typeof setTimeout>[]} */
  #timers = [];

  show() {
    if (this.#root) return;

    const root = document.createElement('div');
    root.id = 'battle-fx';
    root.innerHTML = /* html */ `
      <style>
        #battle-fx {
          position: fixed; inset: 0; pointer-events: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; z-index: 10;
        }
        #battle-fx .banner {
          position: absolute; left: 50%; top: 36%; transform: translate(-50%, -50%);
          font-size: 56px; font-weight: 900; letter-spacing: 4px;
          text-align: center; white-space: nowrap;
          opacity: 0; transition: opacity 220ms ease-out, transform 220ms ease-out;
        }
        #battle-fx .banner.show {
          opacity: 1;
        }
        #battle-fx .banner.bp {
          color: #ffb949;
          text-shadow:
            0 0 24px rgba(255, 138, 58, 0.85),
            0 0 4px rgba(255, 220, 120, 0.95);
          animation: bp-pulse 280ms ease-out 1;
        }
        #battle-fx .banner.victory { color: #ffd84a; text-shadow: 0 0 24px rgba(255, 216, 74, 0.6); }
        #battle-fx .banner.defeat  { color: #e85a5a; text-shadow: 0 0 24px rgba(232, 90, 90, 0.55); }
        #battle-fx .banner.subtitle {
          font-size: 18px; font-weight: 600; letter-spacing: 1px; opacity: 0;
          margin-top: 12px; color: #c8d4e0;
        }
        #battle-fx .vignette {
          position: absolute; inset: 0;
          opacity: 0; transition: opacity 320ms ease-out;
        }
        #battle-fx .vignette.victory { background: radial-gradient(circle at 50% 40%, rgba(255, 216, 74, 0.2), transparent 60%); opacity: 1; }
        #battle-fx .vignette.defeat  { background: radial-gradient(circle at 50% 40%, rgba(232, 90, 90, 0.18), transparent 60%); opacity: 1; }
        #battle-fx .vignette.bp      { background: radial-gradient(circle at 50% 40%, rgba(255, 138, 58, 0.22), transparent 65%); opacity: 1; }
        #battle-fx .flash {
          position: absolute; inset: 0;
          background: rgba(255, 220, 120, 0.4);
          opacity: 0; pointer-events: none;
        }
        #battle-fx .flash.show {
          animation: bp-flash 360ms ease-out 1;
        }
        @keyframes bp-pulse {
          0%   { transform: translate(-50%, -50%) scale(1.4); }
          50%  { transform: translate(-50%, -50%) scale(0.96); }
          100% { transform: translate(-50%, -50%) scale(1.0); }
        }
        @keyframes bp-flash {
          0%   { opacity: 0.85; }
          100% { opacity: 0; }
        }
      </style>
      <div class="vignette" data-bind="vignette"></div>
      <div class="flash" data-bind="flash"></div>
      <div class="banner" data-bind="banner"></div>
    `;
    document.body.appendChild(root);
    this.#root = root;

    this.#unsubs.push(
      eventBus.on(
        'battle.bandPerformanceStarted',
        /** @param {{ name: string }} p */
        (p) => this.#showBandPerformanceBanner(p?.name ?? 'BAND PERFORMANCE!')
      ),
      eventBus.on(
        'battle.gameOver',
        /** @param {{ outcome: 'victory' | 'defeat' }} p */
        (p) => this.#showResultBanner(p.outcome)
      )
    );
  }

  hide() {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
    this.#root?.remove();
    this.#root = null;
  }

  /** @param {string} text */
  #showBandPerformanceBanner(text) {
    if (!this.#root) return;
    this.#setBanner('BAND PERFORMANCE!', text);
    this.#setVignette('bp');
    this.#triggerFlash();
    const banner = this.#qs('banner');
    banner?.classList.add('show', 'bp');
    this.#after(900, () => {
      banner?.classList.remove('show');
      this.#setVignette(null);
    });
  }

  /** @param {'victory' | 'defeat'} outcome */
  #showResultBanner(outcome) {
    if (!this.#root) return;
    const text = outcome === 'victory' ? 'VICTORY!' : 'DEFEATED';
    this.#setBanner(text, '');
    this.#setVignette(outcome);
    const banner = this.#qs('banner');
    banner?.classList.remove('bp');
    banner?.classList.add('show', outcome);
  }

  /** @param {string} title @param {string} _subtitle */
  #setBanner(title, _subtitle) {
    const banner = this.#qs('banner');
    if (banner) banner.textContent = title;
  }

  /** @param {'bp' | 'victory' | 'defeat' | null} kind */
  #setVignette(kind) {
    const v = this.#qs('vignette');
    if (!v) return;
    v.className = 'vignette' + (kind ? ' ' + kind : '');
  }

  #triggerFlash() {
    const f = this.#qs('flash');
    if (!f) return;
    f.classList.remove('show');
    void /** @type {HTMLElement} */ (f).offsetWidth;
    f.classList.add('show');
  }

  /** @param {string} bind @returns {HTMLElement | null} */
  #qs(bind) {
    return /** @type {HTMLElement | null} */ (
      this.#root?.querySelector(`[data-bind="${bind}"]`) ?? null
    );
  }

  /** @param {number} ms @param {() => void} fn */
  #after(ms, fn) {
    const t = setTimeout(fn, ms);
    this.#timers.push(t);
  }
}

export const battleFx = new BattleFx();
