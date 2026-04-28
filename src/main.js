// @ts-check

import { eventBus } from './engine/eventBus.js';
import { dispatch, getState } from './engine/gameState.js';
import { getConfig, listConfigs } from './engine/configService.js';
import { audioManager } from './engine/audioManager.js';
import { RNG } from './util/rng.js';
import { createRenderer } from './engine/renderer.js';

const mount = /** @type {HTMLElement | null} */ (document.getElementById('app'));
const fpsEl = /** @type {HTMLElement | null} */ (document.getElementById('fps'));

if (!mount) {
  throw new Error('Mount point #app not found');
}

// Boot — read main config, seed RNG, init audio, log state changes.
const mainCfg = getConfig('main');
const rng = new RNG(mainCfg.rngSeed ?? 1);
audioManager.setMasterVolume(mainCfg.audio?.masterVolume ?? 0.8);

eventBus.on('stateChanged', ({ action }) => {
  console.log('[state]', action.type, getState());
});

// Sanity-check: the reducer should accept a no-op without crashing.
dispatch({ type: 'GRANT_NOTES', amount: 0 });

console.log('[boot]', {
  configs: listConfigs(),
  main: mainCfg,
  rngSample: rng.next(),
});

const { renderer, scene, camera, resize } = createRenderer(mount);

window.addEventListener('resize', resize);

let lastFrame = performance.now();
let fpsAccumulator = 0;
let fpsFrames = 0;

/** @param {number} now */
function loop(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  fpsAccumulator += dt;
  fpsFrames += 1;
  if (fpsAccumulator >= 0.5 && fpsEl) {
    const fps = fpsFrames / fpsAccumulator;
    fpsEl.textContent = `FPS: ${fps.toFixed(0)}`;
    fpsAccumulator = 0;
    fpsFrames = 0;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
