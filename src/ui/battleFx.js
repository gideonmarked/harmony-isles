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
        #battle-fx .subtitle {
          position: absolute; left: 50%; top: calc(36% + 56px);
          transform: translate(-50%, 0);
          font-size: 18px; font-weight: 600; letter-spacing: 2px;
          color: #c8d4e0;
          opacity: 0; transition: opacity 220ms ease-out;
          white-space: nowrap;
        }
        #battle-fx .subtitle.show { opacity: 0.92; }
        #battle-fx .banner.encounter {
          color: #6ec1ff;
          text-shadow: 0 0 18px rgba(110, 193, 255, 0.6), 0 0 4px rgba(255, 255, 255, 0.6);
          animation: encounter-slide 380ms ease-out 1;
        }
        @keyframes encounter-slide {
          0%   { transform: translate(-50%, -50%) translateX(-40px) skewX(-12deg); opacity: 0; }
          60%  { transform: translate(-50%, -50%) translateX(0) skewX(0deg); opacity: 1; }
          100% { transform: translate(-50%, -50%) translateX(0) skewX(0deg); opacity: 1; }
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
      <div class="subtitle" data-bind="subtitle"></div>
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
      ),
      eventBus.on(
        'battle.encounterStarted',
        /** @param {{ encounterName: string, playerName: string, enemyName: string }} p */
        (p) => this.#showEncounterTelegraph(p.encounterName, p.playerName, p.enemyName)
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
    this.#setSubtitle('');
    this.#setVignette(outcome);
    const banner = this.#qs('banner');
    banner?.classList.remove('bp', 'encounter');
    banner?.classList.add('show', outcome);
  }

  /**
   * @param {string} encounterName
   * @param {string} playerName
   * @param {string} enemyName
   */
  #showEncounterTelegraph(encounterName, playerName, enemyName) {
    if (!this.#root) return;
    this.#setBanner(encounterName, '');
    this.#setSubtitle(`${playerName}  vs  ${enemyName}`);
    const banner = this.#qs('banner');
    const sub = this.#qs('subtitle');
    banner?.classList.remove('bp', 'victory', 'defeat');
    banner?.classList.add('show', 'encounter');
    sub?.classList.add('show');
    this.#after(1100, () => {
      banner?.classList.remove('show', 'encounter');
      sub?.classList.remove('show');
    });
  }

  /** @param {string} title @param {string} _subtitle */
  #setBanner(title, _subtitle) {
    const banner = this.#qs('banner');
    if (banner) banner.textContent = title;
  }

  /** @param {string} text */
  #setSubtitle(text) {
    const sub = this.#qs('subtitle');
    if (sub) sub.textContent = text;
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
