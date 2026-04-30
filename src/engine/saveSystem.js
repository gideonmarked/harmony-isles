// @ts-check

import { eventBus } from './eventBus.js';
import { hydrateState, serializeState, resetState, getState } from './gameState.js';

/**
 * Save system — design doc §26.
 *
 * Three numbered slots in LocalStorage, each holding a versioned
 * snapshot of GameStateData plus a few profile-level metadata fields
 * (last played, playtime — currently not tracked but reserved). The
 * persisted shape lives in `harmony_isles__profile_{0,1,2}__data` so
 * future savefile types can sit alongside without colliding.
 *
 * Auto-save policy: subscribe to a curated set of "checkpoint"
 * events (battle ends, shop purchases, island transitions, manager
 * style picks) and write to the active slot. The write itself is
 * debounced via requestIdleCallback / setTimeout so a flurry of
 * dispatches in the same tick coalesce into one write.
 *
 * Versioning: each save carries `version: '1.0.0'`. On load we run
 * `migrate(saved)` which is a no-op today; if/when the shape
 * changes, add a chained migration there.
 */

const SAVE_VERSION = '1.0.0';
const KEY_PREFIX = 'harmony_isles__profile_';
const ACTIVE_SLOT_KEY = 'harmony_isles__active_slot';
const MAX_SLOTS = 3;

/**
 * @typedef {object} SaveBlob
 * @property {string} version
 * @property {string} createdAt
 * @property {string} lastSavedAt
 * @property {number} playtimeMs   reserved; we don't track yet
 * @property {string} profileName
 * @property {import('./gameState.js').GameStateData} state
 */

/** @param {number} slot @returns {string} */
function slotKey(slot) {
  return `${KEY_PREFIX}${slot}__data`;
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read a slot's raw blob without hydrating.
 *
 * @param {number} slot
 * @returns {SaveBlob | null}
 */
function readBlob(slot) {
  const ls = safeStorage();
  if (!ls) return null;
  const raw = ls.getItem(slotKey(slot));
  if (!raw) return null;
  try {
    const parsed = /** @type {SaveBlob} */ (JSON.parse(raw));
    return migrate(parsed);
  } catch (e) {
    console.error('saveSystem: corrupt slot', slot, e);
    return null;
  }
}

/**
 * Migration chain. Add cases here when SAVE_VERSION bumps.
 *
 * @param {SaveBlob} blob
 * @returns {SaveBlob}
 */
function migrate(blob) {
  // 1.0.0 is the current shape — nothing to do yet.
  if (blob.version !== SAVE_VERSION) {
    console.warn(
      `saveSystem: unknown save version "${blob.version}" — loading as-is`
    );
  }
  return blob;
}

class SaveSystem {
  /** Slot the auto-save writes into. Default 0 unless the player picks. */
  #activeSlot = 0;
  /** Debounce timer for auto-save bursts. */
  #pendingWrite = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  /** Set of unsubscribers for the auto-save event subscriptions. */
  #unsubs = /** @type {(() => void)[]} */ ([]);

  /**
   * Read the slot the player last selected, or default to 0. Called
   * once at boot before the title scene runs.
   */
  init() {
    const ls = safeStorage();
    if (ls) {
      const raw = ls.getItem(ACTIVE_SLOT_KEY);
      const n = raw ? parseInt(raw, 10) : NaN;
      this.#activeSlot = Number.isFinite(n) && n >= 0 && n < MAX_SLOTS ? n : 0;
    }
  }

  get activeSlot() {
    return this.#activeSlot;
  }

  /**
   * Switch the active slot. Persisted so the next boot remembers.
   *
   * @param {number} slot
   */
  setActiveSlot(slot) {
    if (slot < 0 || slot >= MAX_SLOTS) return;
    this.#activeSlot = slot;
    const ls = safeStorage();
    ls?.setItem(ACTIVE_SLOT_KEY, String(slot));
  }

  /**
   * Lightweight summary for each slot — what the title-screen profile
   * picker shows ("Slot 1: Cred 7 · 4500 N"). Returns one entry per
   * slot, with null for empty ones.
   *
   * @returns {(null | { slot: number, profileName: string, lastSavedAt: string,
   *                     credibility: number, exp: number, notes: number, owned: number,
   *                     captures: number })[]}
   */
  listSlots() {
    /** @type {ReturnType<SaveSystem['listSlots']>} */
    const out = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const blob = readBlob(i);
      if (!blob) {
        out.push(null);
      } else {
        out.push({
          slot: i,
          profileName: blob.profileName,
          lastSavedAt: blob.lastSavedAt,
          credibility: blob.state.manager.credibility,
          exp: blob.state.manager.exp,
          notes: blob.state.manager.notes,
          owned: blob.state.world.ownedIslands.length,
          captures: blob.state.capturedRivals.length,
        });
      }
    }
    return out;
  }

  /**
   * Save the current GameState into the active slot now. Use this
   * for explicit checkpoints (e.g. quit-to-title); auto-save uses
   * the debounced `scheduleSave()`.
   *
   * @param {string} [profileName]
   */
  saveNow(profileName) {
    const ls = safeStorage();
    if (!ls) return;
    const existing = readBlob(this.#activeSlot);
    /** @type {SaveBlob} */
    const blob = {
      version: SAVE_VERSION,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastSavedAt: new Date().toISOString(),
      playtimeMs: existing?.playtimeMs ?? 0,
      profileName: profileName ?? existing?.profileName ?? 'Manager',
      state: serializeState(),
    };
    try {
      ls.setItem(slotKey(this.#activeSlot), JSON.stringify(blob));
      eventBus.emit('save.written', { slot: this.#activeSlot, blob });
    } catch (e) {
      console.error('saveSystem: write failed', e);
    }
  }

  /**
   * Coalesce repeated calls into one write at the end of the tick.
   * Auto-save handlers call this; multiple dispatches in quick
   * succession (e.g. battle.gameOver firing right after a Notes
   * grant) result in one write rather than N.
   */
  scheduleSave() {
    if (this.#pendingWrite) return;
    this.#pendingWrite = setTimeout(() => {
      this.#pendingWrite = null;
      this.saveNow();
    }, 60);
  }

  /**
   * Hydrate the live GameState from the active slot, if any.
   * Returns true if a save was loaded, false if the slot is empty
   * (caller should treat that as a fresh New Game).
   */
  loadActive() {
    const blob = readBlob(this.#activeSlot);
    if (!blob) return false;
    hydrateState(blob.state);
    eventBus.emit('save.loaded', { slot: this.#activeSlot, blob });
    return true;
  }

  /**
   * Hydrate a specific slot. Used by the title-screen picker when
   * the player taps "Continue" on a slot that isn't currently active.
   *
   * @param {number} slot
   */
  loadSlot(slot) {
    this.setActiveSlot(slot);
    return this.loadActive();
  }

  /**
   * Wipe a slot. Confirmed by the caller — this method does not
   * prompt.
   *
   * @param {number} slot
   */
  deleteSlot(slot) {
    const ls = safeStorage();
    if (!ls) return;
    ls.removeItem(slotKey(slot));
    eventBus.emit('save.deleted', { slot });
  }

  /**
   * Reset GameState to a brand-new game and write that to the active
   * slot. Used by the title picker's "New Game" flow.
   *
   * @param {string} [profileName]
   */
  startNewGame(profileName) {
    resetState();
    this.saveNow(profileName ?? 'Manager');
  }

  /**
   * Subscribe to checkpoint events that should trigger a save. Call
   * once at boot, after `init()`. Returns an unsubscribe handle in
   * case the caller wants to detach later (tests).
   */
  attachAutoSave() {
    this.#unsubs.push(
      eventBus.on('battle.gameOver', () => this.scheduleSave()),
      eventBus.on('shop.islandPurchased', () => this.scheduleSave()),
      eventBus.on('stateChanged', (payload) => {
        const action = /** @type {{ action: { type: string } }} */ (
          payload ?? {}
        ).action;
        // Save on a curated set of meaningful actions only — saving
        // on every single state change is wasteful and writes mid-
        // animation can stutter on slow machines.
        if (
          action?.type === 'ENTER_ISLAND' ||
          action?.type === 'SELECT_MANAGER_STYLE' ||
          action?.type === 'PURCHASE_ISLAND' ||
          action?.type === 'RECRUIT_RIVAL' ||
          action?.type === 'ADD_TO_TEAM' ||
          action?.type === 'REMOVE_FROM_TEAM' ||
          action?.type === 'REORDER_TEAM' ||
          action?.type === 'LEVEL_UP_RIVAL'
        ) {
          this.scheduleSave();
        }
      })
    );
    return () => {
      for (const u of this.#unsubs) u();
      this.#unsubs = [];
    };
  }

  /** @returns {number} */
  static get MAX_SLOTS() {
    return MAX_SLOTS;
  }

  /** Force-flush any pending debounced save (e.g. on page unload). */
  flush() {
    if (this.#pendingWrite) {
      clearTimeout(this.#pendingWrite);
      this.#pendingWrite = null;
      this.saveNow();
    }
  }

  /** Quick sanity check for tests / debug. */
  debugSnapshot() {
    return { activeSlot: this.#activeSlot, currentState: getState() };
  }
}

export const saveSystem = new SaveSystem();
export { MAX_SLOTS };
