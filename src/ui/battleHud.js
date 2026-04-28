// @ts-check

import { eventBus } from '../engine/eventBus.js';

/**
 * Battle HUD — DOM overlay showing player HP, enemy HP, the Hype meter,
 * and a prompt line. Subscribes to EventBus for state changes so the
 * battle system stays decoupled from rendering.
 *
 * Events consumed:
 *   - battle.charactersChanged   { player, enemy }
 *   - battle.hpChanged           { side: 'player'|'enemy', hp, hpMax }
 *   - battle.hypeChanged         { value, max }
 *   - battle.promptChanged       { text }
 */
class BattleHud {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unsubs = [];

  show() {
    if (this.#root) return;

    const root = document.createElement('div');
    root.id = 'battle-hud';
    root.innerHTML = /* html */ `
      <style>
        #battle-hud {
          position: fixed; inset: 0; pointer-events: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2; font-size: 13px; line-height: 1.3;
        }
        #battle-hud .panel {
          position: absolute; padding: 10px 14px;
          background: rgba(14, 18, 26, 0.85);
          border: 1px solid #2a3340; border-radius: 4px;
          min-width: 180px;
        }
        #battle-hud .player { top: 16px; left: 16px; }
        #battle-hud .enemy  { top: 16px; right: 16px; text-align: right; }
        #battle-hud .hype   { bottom: 16px; left: 50%; transform: translateX(-50%); width: 320px; text-align: center; }
        #battle-hud .prompt {
          bottom: 92px; left: 50%; transform: translateX(-50%);
          font-size: 16px; padding: 12px 20px; min-width: 0;
          background: rgba(110, 193, 255, 0.15);
          border-color: #6ec1ff;
        }
        #battle-hud .name { font-weight: bold; margin-bottom: 4px; }
        #battle-hud .bar { width: 100%; height: 8px; background: #1a2230; border-radius: 2px; overflow: hidden; margin: 4px 0; }
        #battle-hud .bar-fill { height: 100%; transition: width 220ms ease-out; }
        #battle-hud .bar-fill.hp   { background: #e85a5a; }
        #battle-hud .bar-fill.hype { background: #ffb949; }
        #battle-hud .num { font-variant-numeric: tabular-nums; opacity: 0.85; }
        #battle-hud .panel.hype.full {
          border-color: #ffb949;
          box-shadow: 0 0 18px rgba(255, 185, 73, 0.55);
          animation: hud-hype-pulse 900ms ease-in-out infinite;
        }
        #battle-hud .panel.hype.full .bar-fill.hype {
          background: linear-gradient(90deg, #ffb949 0%, #ffe27d 50%, #ffb949 100%);
          background-size: 200% 100%;
          animation: hud-hype-shimmer 1.6s linear infinite;
        }
        @keyframes hud-hype-pulse {
          0%, 100% { box-shadow: 0 0 12px rgba(255, 185, 73, 0.35); }
          50%      { box-shadow: 0 0 24px rgba(255, 185, 73, 0.85); }
        }
        @keyframes hud-hype-shimmer {
          0%   { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
      </style>
      <div class="panel player">
        <div class="name" data-bind="player-name">Player</div>
        <div class="bar"><div class="bar-fill hp" data-bind="player-hp" style="width:100%"></div></div>
        <div class="num" data-bind="player-hp-text">--/--</div>
      </div>
      <div class="panel enemy">
        <div class="name" data-bind="enemy-name">Enemy</div>
        <div class="bar"><div class="bar-fill hp" data-bind="enemy-hp" style="width:100%"></div></div>
        <div class="num" data-bind="enemy-hp-text">--/--</div>
      </div>
      <div class="panel hype">
        <div>HYPE</div>
        <div class="bar"><div class="bar-fill hype" data-bind="hype" style="width:0%"></div></div>
        <div class="num" data-bind="hype-text">0 / 100</div>
      </div>
      <div class="panel prompt" data-bind="prompt">--</div>
    `;
    document.body.appendChild(root);
    this.#root = root;

    this.#unsubs.push(
      eventBus.on(
        'battle.charactersChanged',
        /** @param {{ player: { name: string, hp: number, hpMax: number }, enemy: { name: string, hp: number, hpMax: number } }} p */
        (p) => {
          this.#setText('player-name', p.player.name);
          this.#setText('enemy-name', p.enemy.name);
          this.#setHp('player', p.player.hp, p.player.hpMax);
          this.#setHp('enemy', p.enemy.hp, p.enemy.hpMax);
        }
      ),
      eventBus.on(
        'battle.hpChanged',
        /** @param {{ side: 'player'|'enemy', hp: number, hpMax: number }} p */
        (p) => this.#setHp(p.side, p.hp, p.hpMax)
      ),
      eventBus.on(
        'battle.hypeChanged',
        /** @param {{ value: number, max: number }} p */
        (p) => {
          const pct = p.max > 0 ? (p.value / p.max) * 100 : 0;
          this.#setStyleWidth('hype', pct);
          this.#setText('hype-text', `${Math.round(p.value)} / ${p.max}`);
          const panel = this.#root?.querySelector('.panel.hype');
          panel?.classList.toggle('full', p.value >= p.max);
        }
      ),
      eventBus.on(
        'battle.promptChanged',
        /** @param {{ text: string }} p */
        (p) => this.#setText('prompt', p.text)
      )
    );
  }

  hide() {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    this.#root?.remove();
    this.#root = null;
  }

  /** @param {'player'|'enemy'} side @param {number} hp @param {number} hpMax */
  #setHp(side, hp, hpMax) {
    const pct = hpMax > 0 ? (hp / hpMax) * 100 : 0;
    this.#setStyleWidth(`${side}-hp`, pct);
    this.#setText(`${side}-hp-text`, `${hp} / ${hpMax}`);
  }

  /** @param {string} bind @param {string} text */
  #setText(bind, text) {
    const el = this.#root?.querySelector(`[data-bind="${bind}"]`);
    if (el) el.textContent = text;
  }

  /** @param {string} bind @param {number} pct */
  #setStyleWidth(bind, pct) {
    const el = /** @type {HTMLElement | null} */ (
      this.#root?.querySelector(`[data-bind="${bind}"]`) ?? null
    );
    if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

export const battleHud = new BattleHud();
