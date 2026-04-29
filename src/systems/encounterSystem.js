// @ts-check

import { eventBus } from '../engine/eventBus.js';
import { getConfig } from '../engine/configService.js';

/**
 * Encounter system — owns the per-step random-encounter roll on
 * walkable tiles per design doc §12.2-12.3.
 *
 * Formula:
 *   P(encounter) = base
 *     × (isNight ? nightMultiplier : 1.0)
 *     × (1 + min(cap, floor(mgrCred / every) × additive))
 *     × tileTypeMult (grass:1.0, stage:1.2, path:0)
 *
 * Anti-frustration buffers:
 *   - Pity floor: after `pityFloorSteps` consecutive eligible steps
 *     without an encounter, the next eligible step is forced true.
 *   - Cooldown: after a Jam Clash ends, suppress encounter rolls for
 *     `postBattleCooldownSteps` steps so the player isn't tossed
 *     straight back into combat.
 *
 * The system never imports the battle or scene modules directly — it
 * fires `encounter.triggered` on the EventBus and the scene listens.
 *
 * @typedef {object} EncounterRollResult
 * @property {boolean} triggered
 * @property {number}  chance
 * @property {boolean} pity      true if forced by the pity floor
 * @property {boolean} cooldown  true if the roll was suppressed
 *
 * @typedef {object} EncounterRollOpts
 * @property {string} tileType
 * @property {boolean} [isNight]
 * @property {number}  [managerCredibility]
 */

class EncounterSystem {
  /** Steps taken on eligible tiles since the last encounter. */
  #stepsSinceEncounter = 0;
  /** Eligible steps to suppress after the most recent battle. */
  #cooldownRemaining = 0;
  /** Cached config snapshot. */
  #cfg = /** @type {ReturnType<typeof getEncountersCfg>} */ (null);

  /** Reset per-island counters. Call when entering a new island. */
  reset() {
    this.#stepsSinceEncounter = 0;
    this.#cooldownRemaining = 0;
    this.#cfg = getEncountersCfg();
  }

  /**
   * Engage the post-battle cooldown so the next several eligible
   * steps cannot trigger an encounter. Call from the scene that
   * receives `battle.gameOver` (or directly when battle resolves).
   */
  startPostBattleCooldown() {
    if (!this.#cfg) this.#cfg = getEncountersCfg();
    this.#cooldownRemaining = this.#cfg.rolls.postBattleCooldownSteps ?? 0;
  }

  /**
   * Roll for an encounter on the just-completed step. Emits
   * `encounter.rolled` with diagnostics, and `encounter.triggered`
   * (with the encounter table id) if the roll succeeded.
   *
   * @param {EncounterRollOpts & { rng: () => number, tableId?: string }} opts
   * @returns {EncounterRollResult}
   */
  roll(opts) {
    if (!this.#cfg) this.#cfg = getEncountersCfg();
    const tile = this.#cfg.tiles[opts.tileType];
    const tileMult = tile?.encounterMult ?? 0;

    // Path / bridge / spawn / wall tiles aren't encounter-eligible —
    // walking on them does not advance the pity counter or the
    // cooldown. The §12 design treats them as fully neutral.
    if (tileMult <= 0) {
      const result = { triggered: false, chance: 0, pity: false, cooldown: false };
      eventBus.emit('encounter.rolled', { ...result, ineligible: true });
      return result;
    }

    if (this.#cooldownRemaining > 0) {
      this.#cooldownRemaining -= 1;
      const result = { triggered: false, chance: 0, pity: false, cooldown: true };
      eventBus.emit('encounter.rolled', result);
      return result;
    }

    const r = this.#cfg.rolls;
    const cred = Math.max(1, opts.managerCredibility ?? 1);
    const credBonus = Math.min(
      r.credBonusCap,
      Math.floor(cred / r.credBonusEvery) * r.credBonusAdditive
    );
    const nightMult = opts.isNight ? r.nightMultiplier : 1.0;
    const chance = r.baseChance * nightMult * (1 + credBonus) * tileMult;

    this.#stepsSinceEncounter += 1;

    let triggered = opts.rng() < chance;
    let pity = false;
    if (!triggered && this.#stepsSinceEncounter >= r.pityFloorSteps) {
      triggered = true;
      pity = true;
    }

    const result = { triggered, chance, pity, cooldown: false };
    eventBus.emit('encounter.rolled', result);

    if (triggered) {
      this.#stepsSinceEncounter = 0;
      const tableId = opts.tableId ?? 'commonArtists';
      const table = this.#cfg.tables[tableId];
      eventBus.emit('encounter.triggered', { tableId, table, pity });
    }
    return result;
  }

  /** Inspect counters — debug only. */
  debugState() {
    return {
      stepsSinceEncounter: this.#stepsSinceEncounter,
      cooldownRemaining: this.#cooldownRemaining,
    };
  }
}

/**
 * @typedef {object} EncountersConfig
 * @property {Record<string, { walkable: boolean, encounterMult: number }>} tiles
 * @property {{ baseChance: number, nightMultiplier: number, credBonusEvery: number,
 *             credBonusAdditive: number, credBonusCap: number,
 *             pityFloorSteps: number, postBattleCooldownSteps: number }} rolls
 * @property {Record<string, { rarityWeights: Record<string, number>, rolePool: string[],
 *                              rankRange: [number, number] }>} tables
 */

/** @returns {EncountersConfig} */
function getEncountersCfg() {
  return /** @type {EncountersConfig} */ (getConfig('encounters'));
}

export const encounterSystem = new EncounterSystem();
