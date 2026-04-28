// @ts-check

import { eventBus } from './eventBus.js';

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
 * @property {number} notes             in-game currency
 * @property {ManagerStyle | null} style   Picked at new game; permanent until New Game+.
 *
 * @typedef {object} GameStateData
 * @property {ManagerState} manager
 * @property {Record<string, boolean>} flags  ad-hoc booleans for one-off conditions
 *
 * @typedef {{ type: string } & Record<string, any>} GameAction
 */

/** @returns {GameStateData} */
function initialState() {
  return {
    manager: { name: 'Manager', credibility: 1, notes: 0, style: null },
    flags: {},
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
    case 'SET_FLAG':
      return { ...state, flags: { ...state.flags, [action.key]: !!action.value } };
    case 'SELECT_MANAGER_STYLE':
      return { ...state, manager: { ...state.manager, style: action.style } };
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
}
