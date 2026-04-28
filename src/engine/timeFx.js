// @ts-check

/**
 * Time-based feedback effects: hit-pause (freeze game updates briefly)
 * and screen shake (camera offset that decays back to rest).
 *
 * Both are global because they affect the renderer / main loop, which
 * is also global. The battle system requests effects via these helpers
 * rather than threading "freeze" / "shake" callbacks through scenes.
 */

let frozenUntil = 0;

let shakeMagnitude = 0;
let shakeDecayPerSec = 0;

/**
 * Freeze game-state updates for `ms` milliseconds. Rendering still
 * happens — only `sceneManager.update(dt)` is skipped — so the screen
 * holds the moment. Multiple calls extend to the latest deadline.
 *
 * @param {number} ms
 */
export function freezeFor(ms) {
  frozenUntil = Math.max(frozenUntil, performance.now() + ms);
}

export function isFrozen() {
  return performance.now() < frozenUntil;
}

/**
 * Trigger a screen shake. Magnitude is in world units (camera position
 * offset). Decays linearly to zero over `durationMs`.
 *
 * @param {number} magnitude
 * @param {number} durationMs
 */
export function shakeCamera(magnitude, durationMs) {
  shakeMagnitude = Math.max(shakeMagnitude, magnitude);
  if (durationMs > 0) {
    shakeDecayPerSec = Math.max(shakeDecayPerSec, magnitude / (durationMs / 1000));
  }
}

/**
 * Apply the current shake offset to a camera, then advance the decay.
 * Camera is restored to its base position each frame; the offset is
 * applied on top.
 *
 * @param {import('three').Camera} camera
 * @param {{ x: number, y: number, z: number }} basePosition
 * @param {number} dt  Seconds since last frame.
 */
export function applyShakeToCamera(camera, basePosition, dt) {
  if (shakeMagnitude <= 0) {
    camera.position.set(basePosition.x, basePosition.y, basePosition.z);
    return;
  }
  const dx = (Math.random() - 0.5) * 2 * shakeMagnitude;
  const dy = (Math.random() - 0.5) * 2 * shakeMagnitude;
  const dz = (Math.random() - 0.5) * 2 * shakeMagnitude;
  camera.position.set(basePosition.x + dx, basePosition.y + dy, basePosition.z + dz);

  shakeMagnitude = Math.max(0, shakeMagnitude - shakeDecayPerSec * dt);
  if (shakeMagnitude === 0) shakeDecayPerSec = 0;
}

/** Reset all effects — call between scenes if needed. */
export function resetTimeFx() {
  frozenUntil = 0;
  shakeMagnitude = 0;
  shakeDecayPerSec = 0;
}
