// @ts-check

import { dispatch, getState } from '../engine/gameState.js';

/**
 * Toggle a roster member's inclusion in the active team. Encodes the
 * "max 1 per role / max 5 total / team can't be empty" rules in one
 * place so both the roster UI and the character detail popup share
 * the same validation + flash messaging.
 *
 * @param {string} memberId
 * @returns {{ ok: boolean, message: string, action?: 'added'|'removed' }}
 */
export function toggleTeamMembership(memberId) {
  const s = getState();
  const member = s.roster[memberId];
  if (!member) return { ok: false, message: 'Unknown member.' };

  if (s.team.includes(memberId)) {
    if (s.team.length === 1) {
      return {
        ok: false,
        message: `Can't bench ${member.name} — your team would be empty.`,
      };
    }
    dispatch({ type: 'REMOVE_FROM_TEAM', id: memberId });
    return { ok: true, message: `${member.name} benched.`, action: 'removed' };
  }

  const conflict = s.team
    .map((tid) => s.roster[tid])
    .find((m) => m && m.role === member.role);
  if (conflict) {
    return {
      ok: false,
      message: `Already have a ${member.role}: ${conflict.name}. Bench them first.`,
    };
  }
  if (s.team.length >= 5) {
    return { ok: false, message: 'Team is full (max 5).' };
  }
  dispatch({ type: 'ADD_TO_TEAM', id: memberId });
  return { ok: true, message: `${member.name} added to team.`, action: 'added' };
}
