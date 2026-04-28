// @ts-check

import { eventBus } from './eventBus.js';

/**
 * Rhythm engine — pure timing logic for the Jam Clash minigame.
 *
 * The engine is rendering-agnostic: it grades key presses against
 * scheduled note times and emits events. The UI layer subscribes to
 * those events to draw feedback.
 *
 * Clock source is injected so the engine can run against either
 * `performance.now() / 1000` (during dev, before song audio is wired)
 * or `audioManager.getAudioTime()` (in production, the AudioContext
 * clock that stays in lockstep with the audio output device).
 */

/** @typedef {'perfect' | 'good' | 'miss'} HitGrade */

/**
 * @typedef {object} Note
 * @property {number} time   Scheduled hit time, seconds since song start.
 * @property {number} lane   Lane index 0..(lanes-1).
 *
 * @typedef {object} SongPattern
 * @property {string} name
 * @property {number} bpm
 * @property {number} duration  Song length in seconds.
 * @property {number} lanes
 * @property {Note[]} notes
 *
 * @typedef {object} LiveNote
 * @property {Note} note
 * @property {boolean} resolved
 * @property {HitGrade | null} grade
 * @property {number | null} hitDeltaMs   Signed (negative = early, positive = late).
 *
 * @typedef {object} RhythmResult
 * @property {number} perfect
 * @property {number} good
 * @property {number} miss
 * @property {number} totalNotes
 * @property {number} accuracy     Weighted [0..1]: perfect=1.0, good=0.5, miss=0.
 * @property {number} maxStreak
 * @property {number} finalStreak
 * @property {boolean} flawless    True iff every note was perfect.
 *
 * @typedef {object} RhythmController
 * @property {() => void} tick               Call once per frame to auto-miss expired notes.
 * @property {(code: string) => HitGrade | null} onKeyDown
 * @property {() => LiveNote[]} getLiveNotes Read-only snapshot of the note list.
 * @property {() => boolean} isComplete      True once every note is resolved or song ended.
 * @property {() => RhythmResult} getResult
 * @property {() => number} getCurrentTime   Seconds since song start.
 * @property {() => void} stop               Force-resolve any unhit notes as misses.
 */

/** Hit windows in milliseconds. Tunable when "feel" passes happen. */
export const PERFECT_WINDOW_MS = 60;
export const GOOD_WINDOW_MS = 120;

/** Default lane → key code binding (4 lanes, home-row friendly). */
export const LANE_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];

/**
 * Start a rhythm round.
 *
 * @param {SongPattern} pattern
 * @param {() => number} clockFn  Returns seconds since song start.
 * @returns {RhythmController}
 */
export function startRhythm(pattern, clockFn) {
  /** @type {LiveNote[]} */
  const liveNotes = pattern.notes.map((note) => ({
    note,
    resolved: false,
    grade: null,
    hitDeltaMs: null,
  }));

  let perfect = 0;
  let good = 0;
  let miss = 0;
  let streak = 0;
  let maxStreak = 0;
  let stopped = false;

  /** @param {number} absDeltaMs @returns {HitGrade} */
  function gradeForDelta(absDeltaMs) {
    if (absDeltaMs <= PERFECT_WINDOW_MS) return 'perfect';
    if (absDeltaMs <= GOOD_WINDOW_MS) return 'good';
    return 'miss';
  }

  /** @param {LiveNote} ln @param {HitGrade} grade @param {number | null} deltaMs */
  function resolveNote(ln, grade, deltaMs) {
    ln.resolved = true;
    ln.grade = grade;
    ln.hitDeltaMs = deltaMs;
    if (grade === 'perfect') {
      perfect += 1;
      streak += 1;
    } else if (grade === 'good') {
      good += 1;
      streak += 1;
    } else {
      miss += 1;
      streak = 0;
    }
    if (streak > maxStreak) maxStreak = streak;
    eventBus.emit('rhythm.noteJudged', {
      lane: ln.note.lane,
      grade,
      deltaMs,
      streak,
    });
  }

  function tick() {
    if (stopped) return;
    const t = clockFn();
    for (const ln of liveNotes) {
      if (ln.resolved) continue;
      const deltaMs = (t - ln.note.time) * 1000;
      if (deltaMs > GOOD_WINDOW_MS) {
        resolveNote(ln, 'miss', null);
      }
    }
  }

  /**
   * @param {string} code
   * @returns {HitGrade | null}  null when no note matched the key.
   */
  function onKeyDown(code) {
    if (stopped) return null;
    const lane = LANE_KEYS.indexOf(code);
    if (lane === -1) return null;

    const t = clockFn();

    /** @type {LiveNote | null} */
    let best = null;
    let bestAbsDelta = Infinity;

    for (const ln of liveNotes) {
      if (ln.resolved) continue;
      if (ln.note.lane !== lane) continue;
      const deltaMs = (t - ln.note.time) * 1000;
      if (deltaMs < -GOOD_WINDOW_MS || deltaMs > GOOD_WINDOW_MS) continue;
      const abs = Math.abs(deltaMs);
      if (abs < bestAbsDelta) {
        bestAbsDelta = abs;
        best = ln;
      }
    }

    if (!best) {
      // Stray press — emit so UI can show a "miss flash" on the lane.
      eventBus.emit('rhythm.strayPress', { lane });
      return null;
    }

    const deltaMs = (t - best.note.time) * 1000;
    const grade = gradeForDelta(Math.abs(deltaMs));
    resolveNote(best, grade, deltaMs);
    return grade;
  }

  function getLiveNotes() {
    return liveNotes;
  }

  function isComplete() {
    if (stopped) return true;
    if (clockFn() >= pattern.duration) return true;
    return liveNotes.every((ln) => ln.resolved);
  }

  function getCurrentTime() {
    return clockFn();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const ln of liveNotes) {
      if (!ln.resolved) resolveNote(ln, 'miss', null);
    }
  }

  function getResult() {
    const totalNotes = pattern.notes.length;
    const accuracy =
      totalNotes === 0 ? 0 : (perfect * 1.0 + good * 0.5) / totalNotes;
    return {
      perfect,
      good,
      miss,
      totalNotes,
      accuracy,
      maxStreak,
      finalStreak: streak,
      flawless: totalNotes > 0 && perfect === totalNotes,
    };
  }

  return {
    tick,
    onKeyDown,
    getLiveNotes,
    isComplete,
    getCurrentTime,
    getResult,
    stop,
  };
}
