// @ts-check

import { computeBaseStats, computeMemberStats } from '../util/characterStats.js';
import { bindAsClick } from '../util/pointer.js';
import { getState } from '../engine/gameState.js';
import { eventBus } from '../engine/eventBus.js';
import { toggleTeamMembership } from '../util/teamOps.js';

/**
 * Character detail overlay — opens when a roster card is tapped.
 *
 * Shows the member's role/rarity/rank, HP/Energy, base stats vs
 * rarity-scaled stats with the bonus highlighted in the rarity's
 * own color (rare = cyan, epic = purple, legendary = gold). Groove
 * is flagged as the basic-attack stat since Strum scales off it.
 *
 * Lifecycle mirrors itemMenu/songMenu: show(member, onClose), tap
 * outside or the close button to dismiss.
 */

/** @typedef {import('../engine/gameState.js').RosterMember} RosterMember */

const RARITY_COLORS = {
  common:    '#b0bec5',
  rare:      '#6ec1ff',
  epic:      '#c77dff',
  legendary: '#ffd166',
};

const STAT_LABELS = {
  technicality: 'Technicality',
  focus:        'Focus',
  groove:       'Groove',
  confidence:   'Confidence',
  creativity:   'Creativity',
  energy:       'Energy',
};

class CharacterDetailUI {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unbinds = [];
  /** @type {(() => void) | null} */
  #onClose = null;
  /** @type {string | null} */
  #memberId = null;
  /** @type {(() => void) | null} */
  #stateUnsub = null;
  /** @type {string} */
  #flashMessage = '';
  /** @type {ReturnType<typeof setTimeout> | null} */
  #flashTimer = null;

  /**
   * @param {RosterMember} member
   * @param {() => void} onClose
   */
  show(member, onClose) {
    this.hide();
    this.#onClose = onClose;
    this.#memberId = member.id;
    // Re-render whenever team membership changes so the toggle
    // button label and inclusion badge stay in sync — the user can
    // see their roster mutation immediately without closing the
    // popup.
    this.#stateUnsub = eventBus.on('stateChanged', () => this.#refresh());

    const rarityColor =
      RARITY_COLORS[/** @type {keyof typeof RARITY_COLORS} */ (member.rarity)] ??
      RARITY_COLORS.common;

    const root = document.createElement('div');
    root.id = 'character-detail';
    root.innerHTML = /* html */ `
      <style>
        #character-detail {
          position: fixed; inset: 0; z-index: 70;
          background: rgba(8, 10, 16, 0.82);
          backdrop-filter: blur(2px);
          display: flex; align-items: center; justify-content: center;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2;
        }
        #character-detail .panel {
          width: 460px; max-width: 92vw;
          padding: 18px 20px;
          background: rgba(14, 18, 26, 0.96);
          border: 1px solid ${rarityColor};
          border-radius: 10px;
          box-shadow: 0 0 24px ${rarityColor}40;
        }
        #character-detail .head {
          display: flex; justify-content: space-between; align-items: baseline;
          margin-bottom: 4px;
        }
        #character-detail .name {
          font-size: 20px; font-weight: 800; color: #ffd884;
          letter-spacing: 1px;
        }
        #character-detail .rank {
          font-size: 13px; color: #c8d4e0; letter-spacing: 1.5px;
        }
        #character-detail .meta {
          display: flex; gap: 8px; font-size: 11px;
          letter-spacing: 1.5px; text-transform: uppercase;
          margin-bottom: 14px;
        }
        #character-detail .role, #character-detail .rarity {
          padding: 2px 8px; border-radius: 3px;
          background: rgba(255,255,255,0.06);
        }
        #character-detail .rarity {
          color: ${rarityColor};
          border: 1px solid ${rarityColor}80;
        }
        #character-detail .vitals {
          display: flex; gap: 18px;
          padding: 10px 12px; margin-bottom: 14px;
          background: rgba(255,255,255,0.04);
          border-radius: 6px;
          font-size: 13px;
        }
        #character-detail .vitals .v-label {
          color: #8a96a4; letter-spacing: 1px; margin-right: 6px;
        }
        #character-detail .vitals .v-num {
          color: #fffae0; font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        #character-detail .vitals .v-bonus {
          color: ${rarityColor};
          font-size: 11px; margin-left: 4px;
          font-variant-numeric: tabular-nums;
        }
        #character-detail .stats-table {
          display: grid;
          grid-template-columns: 1fr 60px 24px 60px;
          row-gap: 6px; column-gap: 8px;
          font-size: 13px; align-items: baseline;
        }
        #character-detail .stat-label {
          color: #c8d4e0; letter-spacing: 0.5px;
        }
        #character-detail .stat-label.attack::after {
          content: ' (atk)';
          color: #ffb949; font-size: 10px; letter-spacing: 1.5px;
        }
        #character-detail .stat-base {
          color: #8a96a4; text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #character-detail .stat-arrow {
          color: #5a6878; text-align: center;
        }
        #character-detail .stat-final {
          color: #fffae0; font-weight: 700; text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #character-detail .stat-final .bonus {
          color: ${rarityColor};
          margin-left: 4px; font-size: 11px; font-weight: 700;
        }
        #character-detail .legend {
          margin-top: 14px; padding-top: 10px;
          border-top: 1px solid #2a3340;
          font-size: 11px; color: #8a96a4;
          line-height: 1.6;
        }
        #character-detail .legend .swatch {
          display: inline-block; width: 8px; height: 8px;
          background: ${rarityColor}; border-radius: 2px;
          margin-right: 4px;
        }
        #character-detail .flash {
          margin-top: 10px; min-height: 14px;
          font-size: 12px; color: #ffd884; letter-spacing: 1px;
          opacity: 0; transition: opacity 220ms ease-out;
        }
        #character-detail .flash.show { opacity: 1; }
        #character-detail .actions {
          margin-top: 14px; display: flex; gap: 8px;
          justify-content: flex-end; flex-wrap: wrap;
        }
        #character-detail .actions button {
          padding: 8px 16px;
          background: rgba(14, 18, 26, 0.85);
          border: 1px solid #3a4756; border-radius: 6px;
          color: #e8edf2; font-family: inherit; font-size: 12px;
          letter-spacing: 1.5px; cursor: pointer;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        #character-detail .actions button:active {
          background: rgba(255, 185, 73, 0.15);
          border-color: #ffb949;
        }
        #character-detail .actions .toggle-team.add {
          background: rgba(92, 224, 160, 0.10);
          border-color: #5ce0a0; color: #d7ffe8;
        }
        #character-detail .actions .toggle-team.remove {
          background: rgba(255, 185, 73, 0.10);
          border-color: #ffb949; color: #ffe9c0;
        }
        #character-detail .actions .close-btn {
          background: rgba(110, 193, 255, 0.10);
          border-color: #6ec1ff;
        }
      </style>
      <div class="panel" data-bind="panel"></div>
    `;
    document.body.appendChild(root);
    this.#root = root;

    // Tap on the backdrop closes; tap on the panel does not.
    this.#unbinds.push(
      bindAsClick(root, (e) => {
        if (e.target === root) this.#close();
      })
    );

    this.#refresh();
  }

  /**
   * Re-read state for the active member and rebuild the inner panel.
   * Buttons are rebound each pass since their HTML is regenerated;
   * the backdrop click + style block live on the root and persist.
   */
  #refresh() {
    if (!this.#root || !this.#memberId) return;
    const s = getState();
    const member = s.roster[this.#memberId];
    if (!member) {
      // Member was released or otherwise removed — close.
      this.#close();
      return;
    }
    const base = computeBaseStats(member);
    const live = computeMemberStats(member);
    const hasRarityBonus = live.rarityMult > 1.0;
    const inTeam = s.team.includes(this.#memberId);

    const panel = /** @type {HTMLElement | null} */ (
      this.#root.querySelector('[data-bind="panel"]')
    );
    if (!panel) return;

    panel.innerHTML = /* html */ `
      <div class="head">
        <div class="name">${escape(member.name)}</div>
        <div class="rank">Rank ${member.rank}</div>
      </div>
      <div class="meta">
        <span class="role">${member.role}</span>
        <span class="rarity">${member.rarity}</span>
        ${inTeam
          ? `<span class="role" style="color:#5ce0a0;border:1px solid #5ce0a05c">ON TEAM ${s.team.indexOf(this.#memberId) + 1}</span>`
          : ''}
      </div>
      <div class="vitals">
        <div>
          <span class="v-label">HP</span>
          <span class="v-num">${live.hpMax}</span>
          ${hasRarityBonus ? `<span class="v-bonus">(+${live.hpMax - base.hpMax})</span>` : ''}
        </div>
        <div>
          <span class="v-label">Energy</span>
          <span class="v-num">${live.mpMax}</span>
          ${hasRarityBonus ? `<span class="v-bonus">(+${live.mpMax - base.mpMax})</span>` : ''}
        </div>
      </div>
      <div class="stats-table">
        ${Object.entries(STAT_LABELS)
          .map(([key, label]) => {
            const baseV = base.stats[key];
            const liveV = live.stats[key];
            const diff = liveV - baseV;
            const isAttack = key === 'groove';
            return /* html */ `
              <div class="stat-label${isAttack ? ' attack' : ''}">${label}</div>
              <div class="stat-base">${baseV}</div>
              <div class="stat-arrow">→</div>
              <div class="stat-final">
                ${liveV}${diff > 0 ? `<span class="bonus">+${diff}</span>` : ''}
              </div>`;
          })
          .join('')}
      </div>
      <div class="legend">
        <span class="swatch"></span>
        ${hasRarityBonus
          ? `${capitalize(member.rarity)} rarity boosts every stat by ${Math.round((live.rarityMult - 1) * 100)}%.`
          : 'Common rarity — base stats only, no rarity bonus.'}
        <br/>
        <em>(atk)</em> marks the stat that scales the basic Strum attack.
      </div>
      <div class="flash ${this.#flashMessage ? 'show' : ''}" data-bind="flash">${this.#flashMessage}</div>
      <div class="actions">
        <button class="toggle-team ${inTeam ? 'remove' : 'add'}" data-bind="toggle">
          ${inTeam ? 'Remove from Team' : 'Add to Team'}
        </button>
        <button class="close-btn" data-bind="close">Close</button>
      </div>
    `;

    // Drop and rebind any per-render handlers (toggle + close). The
    // backdrop click on root persists across refreshes.
    this.#dropPerRenderBinds();
    const toggleBtn = /** @type {HTMLElement | null} */ (
      panel.querySelector('[data-bind="toggle"]')
    );
    if (toggleBtn) {
      this.#perRenderBinds.push(
        bindAsClick(toggleBtn, () => this.#toggleTeam())
      );
    }
    const closeBtn = /** @type {HTMLElement | null} */ (
      panel.querySelector('[data-bind="close"]')
    );
    if (closeBtn) {
      this.#perRenderBinds.push(bindAsClick(closeBtn, () => this.#close()));
    }
  }

  /** @type {(() => void)[]} */
  #perRenderBinds = [];

  #dropPerRenderBinds() {
    for (const u of this.#perRenderBinds) u();
    this.#perRenderBinds = [];
  }

  #toggleTeam() {
    if (!this.#memberId) return;
    const result = toggleTeamMembership(this.#memberId);
    this.#flash(result.message);
    // stateChanged fires on success → triggers #refresh via the
    // subscription. On failure (rejected by util) we still want the
    // flash to render, so refresh once explicitly here.
    if (!result.ok) this.#refresh();
  }

  /** @param {string} text */
  #flash(text) {
    this.#flashMessage = text;
    if (this.#flashTimer) clearTimeout(this.#flashTimer);
    const el = /** @type {HTMLElement | null} */ (
      this.#root?.querySelector('[data-bind="flash"]')
    );
    if (el) {
      el.textContent = text;
      el.classList.toggle('show', !!text);
    }
    this.#flashTimer = setTimeout(() => {
      this.#flashMessage = '';
      const ref = /** @type {HTMLElement | null} */ (
        this.#root?.querySelector('[data-bind="flash"]')
      );
      if (ref) {
        ref.textContent = '';
        ref.classList.remove('show');
      }
      this.#flashTimer = null;
    }, 2200);
  }

  hide() {
    for (const u of this.#unbinds) u();
    this.#unbinds = [];
    this.#dropPerRenderBinds();
    if (this.#stateUnsub) {
      this.#stateUnsub();
      this.#stateUnsub = null;
    }
    if (this.#flashTimer) {
      clearTimeout(this.#flashTimer);
      this.#flashTimer = null;
    }
    this.#flashMessage = '';
    this.#memberId = null;
    this.#root?.remove();
    this.#root = null;
    this.#onClose = null;
  }

  #close() {
    const cb = this.#onClose;
    this.hide();
    cb?.();
  }

  /** @param {string} code */
  handleKey(code) {
    if (!this.#root) return false;
    if (code === 'Escape') {
      this.#close();
      return true;
    }
    return false;
  }

  get isOpen() {
    return this.#root !== null;
  }
}

/** @param {string} s */
function escape(s) {
  return String(s).replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'
  );
}

/** @param {string} s */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const characterDetailUI = new CharacterDetailUI();
