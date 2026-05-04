// @ts-check

/**
 * Character stat helpers — shared between battleScene (live combat
 * Character construction) and rosterUI (read-only stat display).
 *
 * Single source of truth for §9.2 baselines, §9.3 growth, §7.2
 * rarity multipliers, and the §10 HP / Energy formulas. Anything
 * that needs to know "what would this roster member's stats look
 * like in battle?" should call {@link computeMemberStats}.
 */

/**
 * §9.3 role-specific stat growth per rank. Rivals (and captured
 * roster members) start from the role baseline at rank 1 and grow by
 * these per rank.
 *
 * @type {Record<string, Record<string, number>>}
 */
export const ROLE_STAT_GROWTH = {
  guitarist:   { technicality: 1.4, focus: 1.0, groove: 1.8, confidence: 1.6, creativity: 1.3, energy: 1.2 },
  bassist:     { technicality: 1.1, focus: 1.0, groove: 1.6, confidence: 2.2, creativity: 1.0, energy: 1.2 },
  drummer:     { technicality: 1.2, focus: 1.5, groove: 1.6, confidence: 1.8, creativity: 0.9, energy: 1.7 },
  keyboardist: { technicality: 1.6, focus: 1.0, groove: 0.9, confidence: 1.5, creativity: 1.9, energy: 1.6 },
  singer:      { technicality: 1.0, focus: 1.1, groove: 1.0, confidence: 2.0, creativity: 1.7, energy: 1.4 },
};

/**
 * §9.2 rank-1 baselines per role. Mirrors the rank-1 numbers in
 * rivals.json so a captured Riff Lord and a fresh wild Riff Lord
 * resolve to identical stats.
 *
 * @type {Record<string, Record<string, number>>}
 */
export const ROLE_BASE_STATS = {
  guitarist:   { technicality: 12, focus: 10, groove: 14, confidence: 9,  creativity: 11, energy: 10 },
  bassist:     { technicality: 10, focus: 9,  groove: 13, confidence: 13, creativity: 9,  energy: 10 },
  drummer:     { technicality: 11, focus: 12, groove: 13, confidence: 11, creativity: 8,  energy: 13 },
  keyboardist: { technicality: 13, focus: 9,  groove: 8,  confidence: 9,  creativity: 14, energy: 12 },
  singer:      { technicality: 9,  focus: 10, groove: 9,  confidence: 12, creativity: 13, energy: 11 },
};

/** §7.2 rarity → flat damage / HP / stat multiplier. */
export function rarityMultiplierFor(/** @type {string} */ rarity) {
  switch (rarity) {
    case 'rare':      return 1.2;
    case 'epic':      return 1.5;
    case 'legendary': return 2.0;
    case 'common':
    default:          return 1.0;
  }
}

/**
 * §9.1 compound formula:
 *   stat = round((base + growth × (rank − 1)) × rarityMult)
 *
 * @param {Record<string, number>} stats
 * @param {string} role
 * @param {number} rank
 * @param {number} rarityMult
 * @returns {Record<string, number>}
 */
export function scaleStats(stats, role, rank, rarityMult) {
  const growth = ROLE_STAT_GROWTH[role] ?? ROLE_STAT_GROWTH.guitarist;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, base] of Object.entries(stats)) {
    const g = growth[key] ?? 1.0;
    out[key] = Math.round((base + g * (rank - 1)) * rarityMult);
  }
  return out;
}

/**
 * Resolve a roster member's full battle profile — scaled stats plus
 * the §10 HP and Energy caps a Character would be built with. Roles
 * outside the table fall back to guitarist baselines so a malformed
 * save still renders something.
 *
 * @param {{ role: string, rarity: string, rank: number }} member
 */
export function computeMemberStats(member) {
  const role = ROLE_BASE_STATS[member.role] ? member.role : 'guitarist';
  const baseStats = ROLE_BASE_STATS[role];
  const rarityMult = rarityMultiplierFor(member.rarity);
  const stats = scaleStats(baseStats, role, member.rank, rarityMult);
  const hpMax = Math.round(
    (100 + (member.rank - 1) * 15) * rarityMult + stats.confidence * 2
  );
  const mpMax = Math.round(
    (50 + (member.rank - 1) * 5) * rarityMult + stats.energy * 1.5
  );
  return { role, stats, hpMax, mpMax, rarityMult };
}
