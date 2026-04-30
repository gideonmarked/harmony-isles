// @ts-check

import { eventBus } from './eventBus.js';
import { getConfig } from './configService.js';

/**
 * @typedef {object} ManagerStyle
 * @property {string} id
 * @property {string} name
 * @property {string} theme
 * @property {string} summary
 * @property {string} tradeoff
 * @property {Record<string, number>} effects   See managerStyles.json schema.
 *
 * @typedef {object} ManagerState
 * @property {string} name
 * @property {number} credibility       1–100
 * @property {number} exp               total manager exp earned (§11.2)
 * @property {number} notes             in-game currency
 * @property {ManagerStyle | null} style   Picked at new game; permanent until New Game+.
 *
 * @typedef {object} WorldState
 * @property {string[]} ownedIslands     ids of islands the player owns
 * @property {string} currentIslandId    island the player is currently on
 * @property {PendingEncounter | null} pendingEncounter  rolled by explore, consumed by battle
 *
 * @typedef {object} PendingEncounter
 * @property {number} rank                rolled from the island's encounter table rankRange
 * @property {string} rarity              rolled from rarityWeights (common/rare/epic/legendary)
 * @property {string} tableId             the encounter table id, for diagnostics
 *
 * @typedef {object} GameStateData
 * @property {ManagerState} manager
 * @property {WorldState} world
 * @property {Record<string, number>} inventory   itemId → count
 * @property {Record<string, boolean>} flags  ad-hoc booleans for one-off conditions
 * @property {Record<string, RosterMember>} roster    captured rivals + starters keyed by id
 * @property {string[]} capturedRivals                 templateIds of rivals already captured
 * @property {string[]} team                           ordered roster ids that fight together (max 1 per role)
 *
 * @typedef {object} RosterMember
 * @property {string} id              unique character id (defaults to templateId for captures)
 * @property {string} templateId      rivals.json key the character was minted from
 * @property {string} name
 * @property {string} role            guitarist / bassist / drummer / keyboardist / singer
 * @property {string} rarity          common / rare / epic / legendary
 * @property {number} rank            1–100, leveled via LEVEL_UP_RIVAL
 * @property {number} exp             progress toward next rank
 * @property {string} capturedAt      ISO timestamp; cosmetic
 *
 * @typedef {{ type: string } & Record<string, any>} GameAction
 */

/**
 * Build the starter roster member. New games begin with a single
 * captured guitarist named "You" — your in-band avatar. Captured
 * rivals join them via the roster + team UI.
 *
 * @returns {RosterMember}
 */
function makeStarter() {
  return {
    id: 'starter',
    templateId: 'starter',
    name: 'You',
    role: 'guitarist',
    rarity: 'common',
    rank: 1,
    exp: 0,
    capturedAt: new Date().toISOString(),
  };
}

/** @returns {GameStateData} */
function initialState() {
  const { owned, current } = defaultIslandState();
  const starter = makeStarter();
  return {
    manager: { name: 'Manager', credibility: 1, exp: 0, notes: 5000, style: null },
    world: {
      ownedIslands: owned,
      currentIslandId: current,
      pendingEncounter: null,
    },
    inventory: defaultInventory(),
    flags: {},
    roster: { [starter.id]: starter },
    capturedRivals: [],
    team: [starter.id],
  };
}

/**
 * Read `ownedAtStart: true` islands out of the catalog. Centralized
 * so the shop, world map, and reducer all see the same starting set.
 *
 * @returns {{ owned: string[], current: string }}
 */
function defaultIslandState() {
  /** @type {Record<string, { id: string, ownedAtStart?: boolean, rarity?: string }>} */
  let cfg = {};
  try {
    cfg = /** @type {any} */ (getConfig('islands'));
  } catch {
    // Configs may not be loaded yet during module init; fall back to
    // a sensible default that downstream code can still operate on.
  }
  const owned = Object.values(cfg)
    .filter((i) => i.ownedAtStart)
    .map((i) => i.id);
  // Player starts at the first non-shop island they own; falls back
  // to the shop hub or any owned island.
  const playable = Object.values(cfg).find(
    (i) => i.ownedAtStart && i.rarity !== 'shop'
  );
  const current =
    playable?.id ?? owned[0] ?? Object.keys(cfg)[0] ?? 'garageStage';
  return { owned, current };
}

/**
 * Starting inventory — design doc §2.3 explicitly ships items as part
 * of the demo. The slice cannot earn or buy items yet, so we seed
 * enough to demonstrate every effect.
 *
 * @returns {Record<string, number>}
 */
function defaultInventory() {
  return {
    energyDrink: 2,
    focusPill: 1,
    grooveBooster: 1,
    confidenceBadge: 1,
    creativeSpark: 1,
  };
}

/**
 * Pure reducer — (state, action) → next state. Add cases as systems
 * land. Unknown action types pass through unchanged so dispatching a
 * not-yet-implemented action is a no-op rather than a crash.
 *
 * @param {GameStateData} state
 * @param {GameAction} action
 * @returns {GameStateData}
 */
function reduce(state, action) {
  switch (action.type) {
    case 'GRANT_NOTES':
      return {
        ...state,
        manager: { ...state.manager, notes: state.manager.notes + (action.amount ?? 0) },
      };
    case 'SPEND_NOTES':
      return {
        ...state,
        manager: { ...state.manager, notes: state.manager.notes - (action.amount ?? 0) },
      };
    case 'GRANT_CREDIBILITY': {
      const next = Math.min(100, state.manager.credibility + (action.amount ?? 0));
      return { ...state, manager: { ...state.manager, credibility: next } };
    }
    case 'GRANT_EXP': {
      const next = Math.max(0, state.manager.exp + (action.amount ?? 0));
      return { ...state, manager: { ...state.manager, exp: next } };
    }
    case 'SET_FLAG':
      return { ...state, flags: { ...state.flags, [action.key]: !!action.value } };
    case 'SELECT_MANAGER_STYLE':
      return { ...state, manager: { ...state.manager, style: action.style } };
    case 'CONSUME_ITEM': {
      const have = state.inventory[action.itemId] ?? 0;
      if (have <= 0) return state;
      const next = { ...state.inventory };
      if (have <= 1) delete next[action.itemId];
      else next[action.itemId] = have - 1;
      return { ...state, inventory: next };
    }
    case 'PURCHASE_ISLAND': {
      const { islandId, price } = action;
      if (state.world.ownedIslands.includes(islandId)) return state;
      if (state.manager.notes < (price ?? 0)) return state;
      return {
        ...state,
        manager: { ...state.manager, notes: state.manager.notes - (price ?? 0) },
        world: {
          ...state.world,
          ownedIslands: [...state.world.ownedIslands, islandId],
        },
      };
    }
    case 'ENTER_ISLAND': {
      const { islandId } = action;
      if (!state.world.ownedIslands.includes(islandId)) return state;
      return { ...state, world: { ...state.world, currentIslandId: islandId } };
    }
    case 'SET_PENDING_ENCOUNTER': {
      const { rank, rarity, tableId } = action;
      return {
        ...state,
        world: {
          ...state.world,
          pendingEncounter: { rank, rarity, tableId },
        },
      };
    }
    case 'CLEAR_PENDING_ENCOUNTER':
      return {
        ...state,
        world: { ...state.world, pendingEncounter: null },
      };
    case 'RECRUIT_RIVAL': {
      /** @type {{ templateId: string, name: string, role: string, rarity: string, rank: number }} */
      const { templateId, name, role, rarity, rank } = action;
      // Skip duplicates so capturing Riff Lord twice doesn't clutter
      // the roster. Future: spawn a numbered alt instead.
      if (state.capturedRivals.includes(templateId)) return state;
      const id = templateId;
      /** @type {RosterMember} */
      const member = {
        id,
        templateId,
        name,
        role,
        rarity,
        rank,
        exp: 0,
        capturedAt: new Date().toISOString(),
      };
      return {
        ...state,
        roster: { ...state.roster, [id]: member },
        capturedRivals: [...state.capturedRivals, templateId],
      };
    }
    case 'LEVEL_UP_RIVAL': {
      const { id, ranks } = action;
      const member = state.roster[id];
      if (!member) return state;
      const nextRank = Math.min(100, member.rank + (ranks ?? 1));
      return {
        ...state,
        roster: {
          ...state.roster,
          [id]: { ...member, rank: nextRank, exp: 0 },
        },
      };
    }
    case 'GRANT_RIVAL_EXP': {
      const { id, amount } = action;
      const member = state.roster[id];
      if (!member) return state;
      return {
        ...state,
        roster: {
          ...state.roster,
          [id]: { ...member, exp: Math.max(0, member.exp + (amount ?? 0)) },
        },
      };
    }
    case 'ADD_TO_TEAM': {
      const { id } = action;
      const member = state.roster[id];
      if (!member) return state;
      if (state.team.includes(id)) return state;
      // Max 1 per role — team can hold up to 5 (one of each role).
      const roleConflict = state.team.find(
        (tid) => state.roster[tid]?.role === member.role
      );
      if (roleConflict) return state;
      return { ...state, team: [...state.team, id] };
    }
    case 'REMOVE_FROM_TEAM': {
      const { id } = action;
      const next = state.team.filter((tid) => tid !== id);
      // Don't allow an empty team — you'd have nothing to fight with.
      // The UI should prevent the last removal too.
      if (next.length === 0) return state;
      return { ...state, team: next };
    }
    case 'REORDER_TEAM': {
      /** @type {string[]} */
      const order = action.order ?? [];
      // Filter to known roster members only; preserve dedupe.
      /** @type {string[]} */
      const seen = [];
      for (const id of order) {
        if (state.roster[id] && !seen.includes(id)) seen.push(id);
      }
      if (seen.length === 0) return state;
      return { ...state, team: seen };
    }
    default:
      return state;
  }
}

/** @type {GameStateData} */
let state = initialState();

/** @returns {GameStateData} */
export function getState() {
  return state;
}

/**
 * Dispatch an action through the reducer. Emits `stateChanged`
 * on the global EventBus with `{ action, state }`.
 *
 * @param {GameAction} action
 */
export function dispatch(action) {
  state = reduce(state, action);
  eventBus.emit('stateChanged', { action, state });
}

/** Reset to a fresh initial state — used for new game / tests. */
export function resetState() {
  state = initialState();
  eventBus.emit('stateChanged', { action: { type: 'RESET' }, state });
}

/**
 * Replace the live state with a saved snapshot. Used at boot when
 * loading a profile from LocalStorage. The save system is responsible
 * for shape-validation; this just deep-merges defaults so older saves
 * with missing fields don't crash newer code.
 *
 * Emits a stateChanged with action `HYDRATE` so any subscribed UI
 * re-renders against the loaded state.
 *
 * @param {Partial<GameStateData>} saved
 */
export function hydrateState(saved) {
  const fresh = initialState();
  /** @type {Record<string, RosterMember>} */
  const mergedRoster = { ...fresh.roster, ...(saved.roster ?? {}) };
  // Saves predating the team feature won't have a team. Default to
  // whatever's in the merged roster (capped at 5, max 1 per role) so
  // the player still has someone to fight with on first load.
  /** @type {string[]} */
  let team = saved.team
    ? saved.team.filter((id) => mergedRoster[id])
    : [];
  if (team.length === 0) {
    /** @type {Set<string>} */
    const usedRoles = new Set();
    for (const id of Object.keys(mergedRoster)) {
      const m = mergedRoster[id];
      if (usedRoles.has(m.role)) continue;
      team.push(id);
      usedRoles.add(m.role);
      if (team.length >= 5) break;
    }
  }
  state = {
    manager: { ...fresh.manager, ...(saved.manager ?? {}) },
    world: {
      ...fresh.world,
      ...(saved.world ?? {}),
      // Always start without a pending encounter — saving mid-roll
      // would dump the player straight into a stale battle.
      pendingEncounter: null,
    },
    inventory: { ...fresh.inventory, ...(saved.inventory ?? {}) },
    flags: { ...fresh.flags, ...(saved.flags ?? {}) },
    roster: mergedRoster,
    capturedRivals: saved.capturedRivals
      ? [...saved.capturedRivals]
      : [...fresh.capturedRivals],
    team,
  };
  eventBus.emit('stateChanged', { action: { type: 'HYDRATE' }, state });
}

/**
 * Snapshot of the live state safe to persist — strips transient
 * fields (in-flight rolls, etc.) so a save doesn't pin the player
 * to a stale moment.
 *
 * @returns {GameStateData}
 */
export function serializeState() {
  return {
    ...state,
    world: { ...state.world, pendingEncounter: null },
  };
}

/**
 * Manager exp curve from design doc §11.1:
 *   exp_to_next(rank) = round(80 × 1.18^(rank − 1))
 *
 * Returned as the threshold for the *current* cred level, i.e. how
 * much total exp to spend BEFORE leveling up. Overlays use this to
 * render an "EXP X / Y" progress hint.
 *
 * @param {number} cred
 * @returns {number}
 */
export function expToNextCred(cred) {
  const safe = Math.max(1, cred);
  return Math.round(80 * Math.pow(1.18, safe - 1));
}
