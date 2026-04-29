// @ts-check

import { eventBus } from '../engine/eventBus.js';
import { getState, dispatch } from '../engine/gameState.js';

/**
 * Roster UI — view captures + manage team membership.
 *
 * Each card shows the captured rival's role, rarity, rank, EXP, and
 * a "TEAM" badge if they're currently in the active team. The team
 * is capped at 1 per role and can hold up to 5 (one per role) per
 * design doc §2.3 (active band size = 4, plus the player). The
 * reducer enforces both rules — the UI just displays current state
 * and surfaces the conflict if the player attempts an invalid add.
 *
 * Controls:
 *   ↑/↓ or W/S   move selection
 *   T            toggle selected member in/out of team
 *   R / Esc      close
 */
class RosterUI {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {(() => void)[]} */
  #unsubs = [];
  /** @type {(() => void) | null} */
  #onClose = null;
  /** @type {string[]} */
  #ids = [];
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
    this.#root = this.#buildOverlay();
    document.body.appendChild(this.#root);
    this.#refresh();
    this.#unsubs.push(
      eventBus.on('input.keyDown', (p) => this.#onKey(p)),
      eventBus.on('stateChanged', () => this.#refresh())
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
        if (this.#ids.length > 0) {
          this.#selected =
            (this.#selected - 1 + this.#ids.length) % this.#ids.length;
          this.#refresh();
        }
        break;
      case 'ArrowDown':
      case 'KeyS':
        if (this.#ids.length > 0) {
          this.#selected = (this.#selected + 1) % this.#ids.length;
          this.#refresh();
        }
        break;
      case 'KeyT':
        this.#toggleTeam();
        break;
      case 'Escape':
      case 'KeyR': {
        const cb = this.#onClose;
        this.hide();
        cb?.();
        break;
      }
      default:
        break;
    }
  }

  #toggleTeam() {
    const id = this.#ids[this.#selected];
    if (!id) return;
    const s = getState();
    const member = s.roster[id];
    if (!member) return;
    if (s.team.includes(id)) {
      if (s.team.length === 1) {
        this.#flash(`Can't bench ${member.name} — your team would be empty.`);
        return;
      }
      dispatch({ type: 'REMOVE_FROM_TEAM', id });
      this.#flash(`${member.name} benched.`);
    } else {
      // Pre-validate role conflict so we can show a useful message.
      const conflict = s.team
        .map((tid) => s.roster[tid])
        .find((m) => m && m.role === member.role);
      if (conflict) {
        this.#flash(
          `Already have a ${member.role}: ${conflict.name}. Bench them first.`
        );
        return;
      }
      if (s.team.length >= 5) {
        this.#flash('Team is full (max 5).');
        return;
      }
      dispatch({ type: 'ADD_TO_TEAM', id });
      this.#flash(`${member.name} added to team.`);
    }
  }

  /** @param {string} text */
  #flash(text) {
    this.#flashMessage = text;
    this.#refresh();
    if (this.#flashTimer) clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => {
      this.#flashMessage = '';
      this.#refresh();
      this.#flashTimer = null;
    }, 2000);
  }

  #expToNextRank(/** @type {number} */ rank) {
    return Math.round(80 * Math.pow(1.18, Math.max(1, rank) - 1));
  }

  #refresh() {
    if (!this.#root) return;
    const s = getState();
    // Sort: team members first (in team order), then the rest by capture time.
    const teamSet = new Set(s.team);
    const teamIds = s.team.filter((id) => s.roster[id]);
    const benchIds = Object.keys(s.roster).filter((id) => !teamSet.has(id));
    this.#ids = [...teamIds, ...benchIds];
    if (this.#ids.length === 0) this.#selected = 0;
    else if (this.#selected >= this.#ids.length) this.#selected = this.#ids.length - 1;

    const summary = this.#root.querySelector('[data-bind="summary"]');
    if (summary) {
      summary.textContent =
        `${this.#ids.length} member${this.#ids.length === 1 ? '' : 's'} captured` +
        `  ·  ${s.team.length} on team`;
    }

    const flash = this.#root.querySelector('[data-bind="flash"]');
    if (flash) {
      flash.textContent = this.#flashMessage;
      flash.classList.toggle('show', !!this.#flashMessage);
    }

    const list = this.#root.querySelector('[data-bind="list"]');
    if (!list) return;
    if (this.#ids.length === 0) {
      list.innerHTML = /* html */ `
        <div class="empty">
          No captured members yet — defeat rivals and press Y on the
          victory prompt to add them here.
        </div>`;
      return;
    }
    list.innerHTML = this.#ids
      .map((id, idx) => {
        const m = s.roster[id];
        const inTeam = teamSet.has(id);
        const expCap = this.#expToNextRank(m.rank);
        const teamBadge = inTeam
          ? `<span class="team-badge">TEAM ${s.team.indexOf(id) + 1}</span>`
          : '';
        return /* html */ `
          <div class="card ${idx === this.#selected ? 'active' : ''} ${inTeam ? 'in-team' : ''}" data-idx="${idx}">
            <div class="head">
              <div class="name">${m.name} ${teamBadge}</div>
              <div class="rank">Rk ${m.rank}</div>
            </div>
            <div class="meta">
              <span class="role role-${m.role}">${m.role}</span>
              <span class="rarity rarity-${m.rarity}">${m.rarity}</span>
            </div>
            <div class="exp">EXP ${m.exp.toLocaleString()} / ${expCap.toLocaleString()}</div>
            <div class="hint">${idx === this.#selected ? 'Press T to ' + (inTeam ? 'bench' : 'add to team') : ' '}</div>
          </div>`;
      })
      .join('');
  }

  /** @returns {HTMLElement} */
  #buildOverlay() {
    const root = document.createElement('div');
    root.id = 'roster-overlay';
    root.innerHTML = /* html */ `
      <style>
        #roster-overlay {
          position: fixed; inset: 0; z-index: 12;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2;
          background: rgba(8, 10, 16, 0.78);
          backdrop-filter: blur(2px);
          display: flex; flex-direction: column; align-items: center;
          padding: 6vh 24px;
        }
        #roster-overlay .title {
          font-size: 28px; font-weight: 900; letter-spacing: 4px;
          color: #ffd884;
        }
        #roster-overlay .subtitle {
          font-size: 12px; letter-spacing: 2.5px; color: #8a96a4;
          margin-top: 4px; text-transform: uppercase;
        }
        #roster-overlay .summary {
          margin-top: 14px; font-size: 14px; color: #c8d4e0;
          letter-spacing: 1px;
        }
        #roster-overlay .flash {
          margin-top: 10px; font-size: 13px;
          color: #ffd884; opacity: 0; transition: opacity 220ms ease-out;
          min-height: 18px;
        }
        #roster-overlay .flash.show { opacity: 1; }
        #roster-overlay .list {
          margin-top: 18px;
          display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 12px; padding: 0 24px;
          width: 100%; max-width: 920px;
        }
        #roster-overlay .empty {
          padding: 18px; color: #8a96a4; font-size: 13px;
          text-align: center; line-height: 1.6;
          grid-column: 1 / -1;
        }
        #roster-overlay .card {
          padding: 12px 14px;
          background: rgba(14, 18, 26, 0.92);
          border: 1px solid #2a3340; border-radius: 8px;
          transition: border-color 140ms ease-out, transform 140ms ease-out;
        }
        #roster-overlay .card.active {
          border-color: #ffb949;
          box-shadow: 0 0 14px rgba(255,185,73,0.45);
          transform: translateX(2px);
        }
        #roster-overlay .card.in-team {
          background: rgba(20, 32, 24, 0.92);
        }
        #roster-overlay .head {
          display: flex; justify-content: space-between; align-items: baseline;
        }
        #roster-overlay .name {
          font-size: 15px; font-weight: 700; color: #ffd884;
          letter-spacing: 1px;
        }
        #roster-overlay .team-badge {
          margin-left: 6px; padding: 1px 6px; border-radius: 3px;
          font-size: 9.5px; letter-spacing: 1.5px; color: #5ce0a0;
          background: rgba(92, 224, 160, 0.08);
        }
        #roster-overlay .rank {
          font-size: 12px; color: #8a96a4; letter-spacing: 1.5px;
        }
        #roster-overlay .meta { margin-top: 6px; display: flex; gap: 8px; }
        #roster-overlay .role, #roster-overlay .rarity {
          padding: 1px 6px; border-radius: 3px;
          font-size: 10.5px; letter-spacing: 1.5px;
          text-transform: uppercase;
          background: rgba(255,255,255,0.06);
        }
        #roster-overlay .role-guitarist   { color: #ffb949; }
        #roster-overlay .role-bassist     { color: #c77dff; }
        #roster-overlay .role-drummer     { color: #e0a050; }
        #roster-overlay .role-keyboardist { color: #6ec1ff; }
        #roster-overlay .role-singer      { color: #5ce0a0; }
        #roster-overlay .rarity-common    { color: #b0bec5; }
        #roster-overlay .rarity-rare      { color: #6ec1ff; }
        #roster-overlay .rarity-epic      { color: #c77dff; }
        #roster-overlay .rarity-legendary { color: #ffd166; }
        #roster-overlay .exp { margin-top: 8px; font-size: 12px; color: #6ec1ff; }
        #roster-overlay .hint { margin-top: 4px; font-size: 11px; color: #8a96a4; min-height: 14px; }
        #roster-overlay .card.active .hint { color: #ffb949; }
        #roster-overlay .controls {
          margin-top: 18px; font-size: 12px; color: #8a96a4;
          letter-spacing: 1.5px;
        }
        #roster-overlay .controls kbd {
          display: inline-block; padding: 2px 6px;
          border: 1px solid #3a4756; border-radius: 4px;
          color: #e8edf2; background: rgba(255,255,255,0.04);
          font-family: inherit; font-size: 11px;
        }
      </style>
      <div class="title">ROSTER &amp; BAND</div>
      <div class="subtitle">Captured rivals · max 1 per role on team</div>
      <div class="summary" data-bind="summary"></div>
      <div class="flash" data-bind="flash"></div>
      <div class="list" data-bind="list"></div>
      <div class="controls">
        <kbd>↑</kbd>/<kbd>↓</kbd> select &nbsp;·&nbsp;
        <kbd>T</kbd> toggle team &nbsp;·&nbsp;
        <kbd>R</kbd>/<kbd>Esc</kbd> close
      </div>
    `;
    return root;
  }
}

export const rosterUI = new RosterUI();
