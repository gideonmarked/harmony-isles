// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';

/**
 * Battle scene — currently a stub. Renders an orange placeholder so we
 * can visually confirm the scene transition fired, and listens for
 * Escape to bounce back to the title.
 *
 * Real battle contents (turn queue, action menu, character entities,
 * rhythm minigame overlay, HUD) land in subsequent chunks.
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const battleScene = (() => {
  /** @type {THREE.Group | null} */
  let group = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  return {
    id: 'battle',

    enter(ctx) {
      group = new THREE.Group();

      const placeholder = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        new THREE.MeshStandardMaterial({ color: 0xe0a050 })
      );
      placeholder.position.set(0, 0.6, 0);
      group.add(placeholder);

      ctx.scene.add(group);
      console.log('[scene] battle — press Esc to return to title');

      unsubscribe = eventBus.on(
        'input.keyDown',
        /** @param {{ code: string }} payload */
        (payload) => {
          if (payload?.code === 'Escape') {
            sceneManager.transition('title');
          }
        }
      );
    },

    exit() {
      unsubscribe?.();
      unsubscribe = null;
      if (group?.parent) group.parent.remove(group);
      group = null;
    },
  };
})();
