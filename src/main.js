// @ts-check

import { eventBus } from './engine/eventBus.js';
import { dispatch, getState } from './engine/gameState.js';
import { getConfig, listConfigs } from './engine/configService.js';
import { audioManager } from './engine/audioManager.js';
import { inputManager } from './engine/inputManager.js';
import { sceneManager } from './engine/sceneManager.js';
import { saveSystem } from './engine/saveSystem.js';
import { RNG } from './util/rng.js';
import { createRenderer, CAMERA_BASE_POSITION } from './engine/renderer.js';
import { isFrozen, applyShakeToCamera } from './engine/timeFx.js';
import { assetLoader } from './engine/assetLoader.js';
import { bboxDebug } from './engine/bboxDebug.js';
import { titleScene } from './scenes/titleScene.js';
import { worldMapScene } from './scenes/worldMapScene.js';
import { exploreScene } from './scenes/exploreScene.js';
import { battleScene } from './scenes/battleScene.js';

const mount = /** @type {HTMLElement | null} */ (document.getElementById('app'));
const fpsEl = /** @type {HTMLElement | null} */ (document.getElementById('fps'));

if (!mount) {
  throw new Error('Mount point #app not found');
}

// Boot — read main config, seed RNG, init audio, log state changes.
const mainCfg = getConfig('main');
const rng = new RNG(mainCfg.rngSeed ?? 1);
audioManager.setMasterVolume(mainCfg.audio?.masterVolume ?? 0.8);
 audioManager.register('neonRiff', { src: '/assets/audio/songs/neonRiff.mp3' });

// Asset manifest — register before any scene constructs entities so
// the first Character built can already see its sprite registration.
// Empty by default; entries land as art is dropped into /public/.
assetLoader.registerManifest(
  /** @type {import('./engine/assetLoader.js').AssetManifest} */ (
    getConfig('assetManifest')
  )
);

eventBus.on('stateChanged', ({ action }) => {
  console.log('[state]', action.type, getState());
});

// Sanity-check: the reducer should accept a no-op without crashing.
dispatch({ type: 'GRANT_NOTES', amount: 0 });

// Save / load — read which slot was last active, hydrate it if it
// has data, and start auto-saving on checkpoint events. Title scene
// can override the active slot via saveSystem.loadSlot().
saveSystem.init();
const loaded = saveSystem.loadActive();
saveSystem.attachAutoSave();
window.addEventListener('beforeunload', () => saveSystem.flush());

console.log('[boot]', {
  configs: listConfigs(),
  main: mainCfg,
  rngSample: rng.next(),
  loadedSlot: loaded ? saveSystem.activeSlot : null,
});

const { renderer, scene, camera, resize } = createRenderer(mount);

inputManager.attach();
bboxDebug.attach(scene);
sceneManager.init({ scene, camera });
sceneManager.register(titleScene);
sceneManager.register(worldMapScene);
sceneManager.register(exploreScene);
sceneManager.register(battleScene);
sceneManager.transition('title');

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

  if (!isFrozen()) {
    sceneManager.update(dt);
  }
  applyShakeToCamera(camera, CAMERA_BASE_POSITION, dt);
  bboxDebug.update();

  renderer.render(scene, camera);
  inputManager.endFrame();

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
