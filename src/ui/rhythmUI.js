// @ts-check

import { eventBus } from '../engine/eventBus.js';
import { LANE_KEYS } from '../engine/rhythmEngine.js';

/**
 * Rhythm UI — DOM overlay for the Jam Clash minigame. Renders four
 * vertical lanes with notes falling toward a hit zone at the bottom,
 * plus per-note feedback (Perfect / Good / Miss flashes) driven off
 * the EventBus.
 *
 * Note position is computed each frame from `(noteTime - currentTime)`
 * relative to a `lookAhead` window — a note that's exactly `lookAhead`
 * seconds away spawns at the top, a note at `currentTime` is at the
 * hit zone. This is purely visual; the engine independently grades
 * timing in absolute terms.
 */

const LOOK_AHEAD_S = 2.5;
const LANE_WIDTH = 70;
const LANE_HEIGHT = 380;
const HIT_ZONE_FROM_BOTTOM = 60;
const NOTE_HEIGHT = 14;
const LANE_LABELS = ['D', 'F', 'J', 'K'];
const LANE_COLORS = ['#6ec1ff', '#ffb949', '#a784ff', '#5ce0a0'];

class RhythmUI {
  /** @type {HTMLElement | null} */
  #root = null;
  /** @type {HTMLElement[]} */
  #lanes = [];
  /** @type {HTMLElement[]} */
  #flashEls = [];
  /** @type {(() => void)[]} */
  #unsubs = [];
  /** @type {() => import('../engine/rhythmEngine.js').LiveNote[]} */
  #getLiveNotes = () => [];
  /** @type {() => number} */
  #getNow = () => 0;
  /** @type {Map<import('../engine/rhythmEngine.js').LiveNote, HTMLElement>} */
  #noteEls = new Map();

  /**
   * @param {() => import('../engine/rhythmEngine.js').LiveNote[]} getLiveNotes
   * @param {() => number} getNow
   * @param {{ bandPerformance?: boolean }} [opts]
   */
  show(getLiveNotes, getNow, opts) {
    if (this.#root) this.hide();

    this.#getLiveNotes = getLiveNotes;
    this.#getNow = getNow;

    const root = document.createElement('div');
    root.id = 'rhythm-ui';
    if (opts?.bandPerformance) root.classList.add('band-performance');
    root.innerHTML = /* html */ `
      <style>
        #rhythm-ui {
          position: fixed; inset: 0; pointer-events: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #e8edf2;
        }
        #rhythm-ui .stage {
          position: absolute;
          left: 50%; bottom: 160px; transform: translateX(-50%);
          display: flex; gap: 6px;
          padding: 8px;
          background: rgba(8, 11, 16, 0.6);
          border: 1px solid #1d2632;
          border-radius: 6px;
          transition: background 240ms ease-out, border-color 240ms ease-out, box-shadow 240ms ease-out;
        }
        #rhythm-ui.band-performance .stage {
          background: rgba(50, 14, 24, 0.78);
          border-color: #ff8a3a;
          box-shadow: 0 0 32px rgba(255, 138, 58, 0.35);
        }
        #rhythm-ui.band-performance .lane {
          background: rgba(255, 138, 58, 0.06);
        }
        #rhythm-ui.band-performance .hit-zone {
          border-color: rgba(255, 200, 110, 0.65);
          background: rgba(255, 200, 110, 0.08);
        }
        #rhythm-ui .lane {
          position: relative;
          width: ${LANE_WIDTH}px; height: ${LANE_HEIGHT}px;
          background: rgba(255,255,255,0.03);
          overflow: hidden;
          border-radius: 3px;
        }
        #rhythm-ui .hit-zone {
          position: absolute; left: 0; right: 0;
          bottom: ${HIT_ZONE_FROM_BOTTOM}px;
          height: ${NOTE_HEIGHT}px;
          border-top: 1px solid rgba(255,255,255,0.4);
          border-bottom: 1px solid rgba(255,255,255,0.4);
          background: rgba(255,255,255,0.04);
        }
        #rhythm-ui .note {
          position: absolute; left: 4px; right: 4px;
          height: ${NOTE_HEIGHT}px;
          border-radius: 3px;
          will-change: transform;
        }
        #rhythm-ui .note.resolved { opacity: 0; transition: opacity 100ms ease-out; }
        #rhythm-ui .label {
          position: absolute; left: 0; right: 0; bottom: 4px;
          text-align: center; font-size: 11px;
          color: rgba(255,255,255,0.6);
          letter-spacing: 1px;
        }
        #rhythm-ui .flash {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; font-weight: bold;
          opacity: 0; transition: opacity 220ms ease-out;
          pointer-events: none;
        }
        #rhythm-ui .flash.show { opacity: 1; transition: opacity 0ms; }
        #rhythm-ui .flash.perfect { color: #ffd84a; text-shadow: 0 0 8px rgba(255,216,74,0.7); }
        #rhythm-ui .flash.good    { color: #6ec1ff; }
        #rhythm-ui .flash.miss    { color: #e85a5a; }
        #rhythm-ui .flash.critical {
          color: #fff2a8;
          font-size: 18px;
          text-shadow: 0 0 12px rgba(255, 200, 80, 0.95), 0 0 4px rgba(255, 255, 255, 0.8);
        }
        #rhythm-ui .streak {
          position: absolute;
          left: 50%; bottom: ${160 + LANE_HEIGHT + 18}px;
          transform: translate(-50%, 0) scale(1);
          font-size: 22px; font-weight: 800; letter-spacing: 2px;
          color: #ffd84a;
          text-shadow: 0 0 12px rgba(255, 216, 74, 0.55);
          opacity: 0; transition: opacity 200ms ease-out;
          pointer-events: none;
        }
        #rhythm-ui .streak.show { opacity: 1; }
        #rhythm-ui .streak.bump { animation: streak-bump 240ms ease-out 1; }
        @keyframes streak-bump {
          0%   { transform: translate(-50%, 0) scale(1.0); }
          40%  { transform: translate(-50%, 0) scale(1.25); }
          100% { transform: translate(-50%, 0) scale(1.0); }
        }
      </style>
      <div class="streak" data-bind="streak"></div>
      <div class="stage">
        ${LANE_LABELS.map(
          (lab, i) => /* html */ `
          <div class="lane" data-lane="${i}" style="--lane-color:${LANE_COLORS[i]}">
            <div class="hit-zone"></div>
            <div class="flash" data-lane-flash="${i}"></div>
            <div class="label">${lab}</div>
          </div>`
        ).join('')}
      </div>
    `;
    document.body.appendChild(root);
    this.#root = root;

    this.#lanes = LANE_KEYS.map(
      (_, i) => /** @type {HTMLElement} */ (root.querySelector(`[data-lane="${i}"]`))
    );
    this.#flashEls = LANE_KEYS.map(
      (_, i) => /** @type {HTMLElement} */ (root.querySelector(`[data-lane-flash="${i}"]`))
    );

    this.#unsubs.push(
      eventBus.on(
        'rhythm.noteJudged',
        /** @param {{ lane: number, grade: 'perfect'|'good'|'miss', streak: number, critical: boolean }} p */
        (p) => {
          this.#flash(p.lane, p.grade, p.critical);
          this.#updateStreak(p.streak);
        }
      ),
      eventBus.on(
        'rhythm.strayPress',
        /** @param {{ lane: number }} p */
        (p) => this.#flash(p.lane, 'miss', false)
      )
    );
  }

  /** Call once per frame to reposition notes. */
  update() {
    if (!this.#root) return;
    const now = this.#getNow();
    const notes = this.#getLiveNotes();

    const seenEls = new Set();
    for (const ln of notes) {
      let el = this.#noteEls.get(ln);
      if (!el) {
        el = document.createElement('div');
        el.className = 'note';
        el.style.background = LANE_COLORS[ln.note.lane] ?? '#fff';
        this.#lanes[ln.note.lane]?.appendChild(el);
        this.#noteEls.set(ln, el);
      }
      seenEls.add(el);

      if (ln.resolved) {
        el.classList.add('resolved');
      } else {
        // Distance from hit time, in seconds. Negative = future.
        const delta = ln.note.time - now;
        // Linear map: delta=LOOK_AHEAD → top of lane, delta=0 → hit zone.
        const travel = LANE_HEIGHT - HIT_ZONE_FROM_BOTTOM - NOTE_HEIGHT;
        const fromTop = Math.round(travel - (delta / LOOK_AHEAD_S) * travel);
        el.style.transform = `translate3d(0, ${fromTop}px, 0)`;
        // Hide notes that haven't entered the look-ahead window yet.
        el.style.display = delta > LOOK_AHEAD_S ? 'none' : 'block';
      }
    }

    // Clean up DOM nodes for notes that are no longer in the engine list
    // (currently never happens — engine list is stable for a round —
    // but harmless for future rounds where we recycle notes).
    for (const [ln, el] of this.#noteEls) {
      if (!seenEls.has(el) || !notes.includes(ln)) {
        el.remove();
        this.#noteEls.delete(ln);
      }
    }
  }

  hide() {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    this.#noteEls.clear();
    this.#root?.remove();
    this.#root = null;
    this.#lanes = [];
    this.#flashEls = [];
  }

  /**
   * @param {number} lane
   * @param {'perfect'|'good'|'miss'} grade
   * @param {boolean} critical
   */
  #flash(lane, grade, critical) {
    const el = this.#flashEls[lane];
    if (!el) return;
    el.textContent = critical ? 'CRIT!' : grade.toUpperCase();
    const classes = critical ? `flash ${grade} critical show` : `flash ${grade} show`;
    el.className = classes;
    // Force reflow so the next class change re-triggers the transition.
    void el.offsetWidth;
    el.className = critical ? `flash ${grade} critical` : `flash ${grade}`;
  }

  /** @param {number} streak */
  #updateStreak(streak) {
    const el = /** @type {HTMLElement | null} */ (
      this.#root?.querySelector('[data-bind="streak"]') ?? null
    );
    if (!el) return;
    if (streak >= 3) {
      el.textContent = `STREAK x${streak}`;
      el.classList.add('show');
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    } else {
      el.classList.remove('show', 'bump');
    }
  }
}

export const rhythmUI = new RhythmUI();
