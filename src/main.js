// @ts-check

import { createRenderer } from './engine/renderer.js';

const mount = /** @type {HTMLElement | null} */ (document.getElementById('app'));
const fpsEl = /** @type {HTMLElement | null} */ (document.getElementById('fps'));

if (!mount) {
  throw new Error('Mount point #app not found');
}

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
