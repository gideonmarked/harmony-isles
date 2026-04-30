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
        #battle-hud .team-list {
          display: flex; flex-direction: column; gap: 6px;
        }
        #battle-hud .team-row {
          padding: 6px 8px;
          border: 1px solid transparent;
          border-radius: 4px;
          transition: border-color 160ms ease-out, background 160ms ease-out, opacity 160ms ease-out;
        }
        #battle-hud .team-row.active {
          border-color: #ffb949;
          background: rgba(255, 185, 73, 0.08);
        }
        #battle-hud .team-row.ko {
          opacity: 0.45;
          filter: grayscale(0.6);
        }
        #battle-hud .team-row .row-name {
          font-weight: bold; margin-bottom: 2px;
          display: flex; justify-content: space-between; gap: 6px;
        }
        #battle-hud .team-row .marker {
          font-size: 10px; color: #ffd884;
          opacity: 0; transition: opacity 160ms ease-out;
        }
        #battle-hud .team-row.active .marker { opacity: 1; }
        #battle-hud .team-row .row-bar {
          width: 100%; height: 6px; background: #1a2230; border-radius: 2px; overflow: hidden;
          margin: 3px 0;
        }
        #battle-hud .team-row .row-bar-fill {
          height: 100%; background: #e85a5a;
          transition: width 220ms ease-out;
        }
        #battle-hud .team-row .row-meta {
          font-size: 10.5px; letter-spacing: 1px; color: #8a96a4;
          display: flex; justify-content: space-between;
        }
        #battle-hud .badges {
          margin-top: 4px; display: flex; gap: 6px; justify-content: flex-end;
          font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase;
        }
        #battle-hud .player .badges { justify-content: flex-start; }
        #battle-hud .badge {
          padding: 1px 6px; border-radius: 3px;
          background: rgba(255,255,255,0.06);
        }
        #battle-hud .badge.rank      { color: #c8d4e0; }
        #battle-hud .badge.common    { color: #b0bec5; }
        #battle-hud .badge.rare      { color: #6ec1ff; }
        #battle-hud .badge.epic      { color: #c77dff; }
        #battle-hud .badge.legendary { color: #ffd166; }
        #battle-hud .badge.role-guitarist   { color: #ffb949; }
        #battle-hud .badge.role-bassist     { color: #c77dff; }
        #battle-hud .badge.role-drummer     { color: #e0a050; }
        #battle-hud .badge.role-keyboardist { color: #6ec1ff; }
        #battle-hud .badge.role-singer      { color: #5ce0a0; }
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
        <div class="team-list" data-bind="team-list"></div>
      </div>
      <div class="panel enemy">
        <div class="name" data-bind="enemy-name">Enemy</div>
        <div class="badges" data-bind="enemy-badges"></div>
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
        /**
         * @param {{
         *   team?: Array<{ id: string, name: string, hp: number, hpMax: number, role?: string, rank?: number, rarity?: string }>,
         *   activeId?: string | null,
         *   player: { name: string, hp: number, hpMax: number, role?: string, rank?: number, rarity?: string },
         *   enemy:  { name: string, hp: number, hpMax: number, role?: string, rank?: number, rarity?: string }
         * }} p
         */
        (p) => {
          this.#renderTeamList(p.team ?? [], p.activeId ?? null);
          this.#setText('enemy-name', p.enemy.name);
          this.#setBadges('enemy-badges', p.enemy);
          this.#setHp('enemy', p.enemy.hp, p.enemy.hpMax);
        }
      ),
      eventBus.on(
        'battle.activeChanged',
        /** @param {{ id: string }} p */
        (p) => this.#setActiveRow(p?.id)
      ),
      eventBus.on(
        'battle.hpChanged',
        /** @param {{ side: 'player'|'enemy'|'team', id?: string, hp: number, hpMax: number }} p */
        (p) => {
          if (p.side === 'enemy') {
            this.#setHp('enemy', p.hp, p.hpMax);
          } else if (p.side === 'team' && p.id) {
            this.#setRowHp(p.id, p.hp, p.hpMax);
          } else if (p.side === 'player' && p.id) {
            // Backward compat — treat as team member.
            this.#setRowHp(p.id, p.hp, p.hpMax);
          }
        }
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

  /**
   * Render the team list — one row per member, with active-row
   * highlighting and KO state styling.
   *
   * @param {Array<{ id: string, name: string, hp: number, hpMax: number, role?: string, rank?: number, rarity?: string }>} team
   * @param {string | null} activeId
   */
  #renderTeamList(team, activeId) {
    const list = this.#root?.querySelector('[data-bind="team-list"]');
    if (!list) return;
    list.innerHTML = team
      .map((m) => {
        const isActive = m.id === activeId;
        const isKO = m.hp <= 0;
        const pct = m.hpMax > 0 ? (m.hp / m.hpMax) * 100 : 0;
        const rank = m.rank ? `Rk ${m.rank}` : '';
        const rarity = m.rarity ?? '';
        return /* html */ `
          <div class="team-row ${isActive ? 'active' : ''} ${isKO ? 'ko' : ''}" data-row-id="${m.id}">
            <div class="row-name">
              <span>${m.name}</span>
              <span class="marker">▶ now</span>
            </div>
            <div class="row-meta">
              <span class="role-${m.role ?? ''}">${m.role ?? ''}</span>
              <span>${rank} · ${rarity}</span>
            </div>
            <div class="row-bar"><div class="row-bar-fill" data-row-fill="${m.id}" style="width:${pct}%"></div></div>
            <div class="row-meta"><span data-row-text="${m.id}">${m.hp} / ${m.hpMax}</span></div>
          </div>
        `;
      })
      .join('');
  }

  /** @param {string} id */
  #setActiveRow(id) {
    const list = this.#root?.querySelector('[data-bind="team-list"]');
    if (!list) return;
    list.querySelectorAll('.team-row').forEach((row) => {
      row.classList.toggle('active', row.getAttribute('data-row-id') === id);
    });
  }

  /** @param {string} id @param {number} hp @param {number} hpMax */
  #setRowHp(id, hp, hpMax) {
    const fill = /** @type {HTMLElement | null} */ (
      this.#root?.querySelector(`[data-row-fill="${id}"]`) ?? null
    );
    const text = this.#root?.querySelector(`[data-row-text="${id}"]`);
    const row = this.#root?.querySelector(`[data-row-id="${id}"]`);
    const pct = hpMax > 0 ? (hp / hpMax) * 100 : 0;
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text) text.textContent = `${hp} / ${hpMax}`;
    if (row) row.classList.toggle('ko', hp <= 0);
  }

  /** @param {string} bind @param {string} text */
  #setText(bind, text) {
    const el = this.#root?.querySelector(`[data-bind="${bind}"]`);
    if (el) el.textContent = text;
  }

  /**
   * Render rank + rarity (+ optional role) badges. Empty when none
   * are provided so the existing layout still works for un-tagged
   * combatants (e.g. legacy tests).
   *
   * @param {string} bind
   * @param {{ rank?: number, rarity?: string, role?: string }} info
   */
  #setBadges(bind, info) {
    const el = this.#root?.querySelector(`[data-bind="${bind}"]`);
    if (!el) return;
    /** @type {string[]} */
    const parts = [];
    if (info?.role) parts.push(`<span class="badge role-${info.role}">${info.role}</span>`);
    if (typeof info?.rank === 'number') parts.push(`<span class="badge rank">Rk ${info.rank}</span>`);
    if (info?.rarity) parts.push(`<span class="badge ${info.rarity}">${info.rarity}</span>`);
    el.innerHTML = parts.join('');
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
