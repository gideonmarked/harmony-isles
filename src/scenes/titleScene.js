// @ts-check

import * as THREE from 'three';

import { eventBus } from '../engine/eventBus.js';
import { sceneManager } from '../engine/sceneManager.js';

/**
 * Title scene — placeholder banner mesh and a "press Z" prompt.
 * Real artwork (logo, animated background) drops in here later;
 * for now the blue floating block is just a visual marker so the
 * active scene is obvious during integration testing.
 *
 * @type {import('../engine/sceneManager.js').Scene}
 */
export const titleScene = (() => {
  /** @type {THREE.Group | null} */
  let group = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  return {
    id: 'title',

    enter(ctx) {
      group = new THREE.Group();

      const banner = new THREE.Mesh(
        new THREE.BoxGeometry(3, 0.6, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x6ec1ff })
      );
      banner.position.set(0, 2, 0);
      group.add(banner);

      ctx.scene.add(group);
      console.log('[scene] title — press Z to start a Jam Clash');

      unsubscribe = eventBus.on(
        'input.keyDown',
        /** @param {{ code: string }} payload */
        (payload) => {
          if (payload?.code === 'KeyZ') {
            sceneManager.transition('battle');
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
