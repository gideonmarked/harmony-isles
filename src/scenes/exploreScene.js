// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';
import { getConfig } from '../engine/configService.js';
import { getState, dispatch } from '../engine/gameState.js';
import { setCameraTopDown, setCameraIso } from '../engine/renderer.js';
import { Island } from '../world/island.js';
import { PlayerOverworld } from '../entities/playerOverworld.js';
import { encounterSystem } from '../systems/encounterSystem.js';
import { exploreHud } from '../ui/exploreHud.js';
import { shopUI } from '../ui/shopUI.js';
import { RNG } from '../util/rng.js';

/**
 * Explore scene — Final-Fantasy-style overworld walking with random
 * encounters on every step (design doc §12).
 *
 * Lifecycle:
 *   enter:  build island + player, wire encounter rolls, show HUD
 *   update: drive player movement and animations
 *   exit:   tear down all the above
 *
 * Encounter handoff:
 *   On `player.stepped`, the encounter system rolls (gated by tile
 *   type, pity floor, post-battle cooldown). On `encounter.triggered`
 *   we lock input, show the rarity-tinted '!' telegraph, then
 *   transition to the battle scene. The battle's existing roster
 *   randomization picks the rival; richer table-driven selection is a
 *   later content add.
 *
 * Returning from battle:
 *   The battle scene's Esc handler transitions back to 'explore',
 *   which reruns this scene's enter() — a fresh island instance and
 *   a fresh encounter cooldown. The player respawns at spawnTile.
 *   That's the simplest correct behavior for the slice; preserving
 *   tile position across battles is a nice-to-have.
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const exploreScene = (() => {
  /** Telegraph durations per §12.4. */
  const TELEGRAPH_HOLD_MS = {
    common: 700,
    rare: 900,
    epic: 1300,
    legendary: 2000,
  };

  /** @type {THREE.Group | null} */
  let group = null;
  /** @type {Island | null} */
  let island = null;
  /** @type {PlayerOverworld | null} */
  let player = null;
  /** @type {RNG | null} */
  let rng = null;
  /** @type {(() => void)[]} */
  let unsubs = [];
  /** @type {ReturnType<typeof setTimeout>[]} */
  let timers = [];

  /** Locks movement during the telegraph → battle handoff. */
  let isHandingOff = false;
  /** True while the shop overlay owns input on this island. */
  let shopOpen = false;

  function openShop() {
    if (shopOpen) return;
    shopOpen = true;
    shopUI.show(() => {
      shopOpen = false;
    });
  }

  /** @param {() => void} fn @param {number} ms */
  function delay(fn, ms) {
    const t = setTimeout(fn, ms);
    timers.push(t);
  }

  /**
   * @param {{ tableId: string, table: any, pity: boolean }} payload
   */
  function onEncounterTriggered(payload) {
    if (isHandingOff) return;
    isHandingOff = true;

    // Roll rarity from the table's weights. The telegraph color
    // matches what the player will face in the battle.
    const weights = payload.table?.rarityWeights ?? { common: 100 };
    const rarity = /** @type {'common' | 'rare' | 'epic' | 'legendary'} */ (
      rng?.weighted(weights) ?? 'common'
    );

    // Roll rank from the table's rankRange. Higher-tier islands have
    // higher ranges, so the rival you fight at Open Arena is meatier
    // than what wanders into Garage Stage.
    const range = payload.table?.rankRange ?? [1, 1];
    const lo = range[0] ?? 1;
    const hi = range[1] ?? lo;
    const rank = rng?.intRange(lo, hi) ?? lo;

    // Stash for the battle scene to consume on enter.
    dispatch({
      type: 'SET_PENDING_ENCOUNTER',
      rank,
      rarity,
      tableId: payload.tableId,
    });

    const holdMs = TELEGRAPH_HOLD_MS[rarity] ?? TELEGRAPH_HOLD_MS.common;
    exploreHud.showTelegraph(rarity, holdMs);

    delay(() => {
      sceneManager.transition('battle');
    }, holdMs);
  }

  return {
    id: 'explore',

    enter(ctx) {
      // Top-down camera so WASD = N/S/E/W on a paper map. Battle
      // and title scenes restore the iso pose on their own enter.
      setCameraTopDown();

      group = new THREE.Group();

      // Whatever island the world map sent us to. Fall back to the
      // starter island if state is somehow missing it (e.g. fresh
      // boot before the world map runs).
      const islandId = getState().world.currentIslandId || 'garageStage';
      island = new Island(islandId);
      group.add(island.group);

      player = new PlayerOverworld({ island });
      group.add(player.mesh);

      ctx.scene.add(group);

      // Seeded RNG for deterministic encounter rolls. Re-seeded each
      // entry so post-battle re-entries don't share state with the
      // pre-battle session — design doc §4.3 promotes the RNG state
      // to the save once that lands.
      const main = /** @type {{ rngSeed?: number }} */ (getConfig('main'));
      rng = new RNG((main.rngSeed ?? 1) + Math.floor(performance.now()));

      encounterSystem.reset();
      // The battle just ended and we're back exploring? Cooldown so
      // the player gets a few steps of breathing room before the
      // next roll. Cheap to call unconditionally.
      encounterSystem.startPostBattleCooldown();

      exploreHud.show();
      exploreHud.setIsland({
        name: island.name,
        rarity: island.rarity,
        shopAvailable: islandId === 'musicPlaza',
      });

      const cred = getState().manager.credibility;
      unsubs.push(
        eventBus.on(
          'player.stepped',
          /** @param {{ tileType: string }} payload */
          (payload) => {
            if (isHandingOff || !rng || !island) return;
            // Shop hub / safe islands have no encounter table — skip
            // the roll entirely so the player can wander without
            // worry. Per design doc §6 the Music Plaza is explicitly
            // encounter-free.
            if (!island.encounterTable) return;
            encounterSystem.roll({
              tileType: payload.tileType,
              isNight: false,
              managerCredibility: cred,
              rng: () => rng.next(),
              tableId: island.encounterTable,
            });
          }
        )
      );

      unsubs.push(
        eventBus.on(
          'encounter.triggered',
          /** @param {{ tableId: string, table: any, pity: boolean }} p */
          (p) => onEncounterTriggered(p)
        )
      );

      unsubs.push(
        eventBus.on(
          'input.keyDown',
          /** @param {{ code: string }} payload */
          (payload) => {
            if (!payload) return;
            // Shop overlay owns input while open — let it handle its
            // own Esc/B close before the scene's exit binding fires.
            if (shopOpen) return;
            if (payload.code === 'KeyB') {
              // Shop only opens while standing inside Music Plaza —
              // the dedicated hub. Anywhere else, B is a no-op.
              if (getState().world.currentIslandId === 'musicPlaza') {
                openShop();
              }
              return;
            }
            if (payload.code === 'Escape' || payload.code === 'KeyM') {
              // M (or Esc) returns to the world map per design doc
              // §31.3.
              sceneManager.transition('worldMap');
            }
          }
        )
      );

      isHandingOff = false;
    },

    update(dt) {
      if (isHandingOff || shopOpen) return;
      player?.update(dt);
    },

    exit() {
      for (const u of unsubs) u();
      unsubs = [];
      for (const t of timers) clearTimeout(t);
      timers = [];

      if (shopOpen) {
        shopUI.hide();
        shopOpen = false;
      }

      exploreHud.hide();

      // Restore iso for the next scene (battle / title) so they get
      // the angled view they're authored for.
      setCameraIso();

      if (group?.parent) group.parent.remove(group);
      group = null;
      island = null;
      player = null;
      rng = null;
      isHandingOff = false;
    },
  };
})();
