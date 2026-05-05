// @ts-check

import * as THREE from 'three';

/**
 * Pixels per world tile. The orthographic camera frustum is sized
 * each frame so 1 world unit (= 1 tile) is exactly this many screen
 * pixels regardless of window dimensions. Bumping it shrinks the
 * visible map; lowering it widens it.
 */
const TILE_PIXEL_SIZE = 64;

/**
 * Camera rest position. Mutable so scenes can switch between iso
 * (battle) and top-down (explore) without losing the screen-shake
 * snap-back anchor — `applyShakeToCamera` reads x/y/z each frame.
 */
export const CAMERA_BASE_POSITION = { x: 20, y: 20, z: 20 };

/** Default iso pose, kept verbatim so we can restore from any other pose. */
const ISO_POSE = Object.freeze({
  pos: { x: 20, y: 20, z: 20 },
  up: { x: 0, y: 1, z: 0 },
});

/**
 * Top-down pose. With up = (0, 0, -1) the world's −Z axis is "screen
 * up", which makes WASD movement feel like N/S/E/W on a paper map:
 * W = decrease tileY = decrease world Z = move up on screen.
 */
const TOP_DOWN_POSE = Object.freeze({
  pos: { x: 0, y: 25, z: 0.0001 },
  up: { x: 0, y: 0, z: -1 },
});

/** @type {THREE.OrthographicCamera | null} */
let activeCamera = null;

/**
 * Build a Three.js orthographic-isometric renderer with a placeholder
 * scene. The camera is angled to produce a 2:1 isometric look; sprites
 * and tiles are placed on the XZ ground plane with Y used for sort
 * tricks.
 *
 * The placeholder content (one colored ground tile and a debug cube) is
 * here purely to confirm the projection looks correct in the browser.
 * Real entities replace it once the engine modules land.
 *
 * @param {HTMLElement} mount  Container element to mount the canvas in.
 * @returns {{
 *   renderer: THREE.WebGLRenderer,
 *   scene: THREE.Scene,
 *   camera: THREE.OrthographicCamera,
 *   resize: () => void,
 * }}
 */
export function createRenderer(mount) {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0b0d12, 1);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // Initial frustum is overwritten by resize() below; values here just
  // need to be valid before the first resize fires.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  activeCamera = camera;
  setCameraIso();

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(10, 20, 5);
  scene.add(sun);

  // Ground tile — placeholder arena floor. Real tilemaps drop in
  // here when island art is authored.
  const tile = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a7a5e })
  );
  tile.rotation.x = -Math.PI / 2;
  scene.add(tile);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Vertical frustum extent in world units = pixels / px-per-tile.
    // 1 tile maps to TILE_PIXEL_SIZE pixels regardless of window size.
    const viewH = h / TILE_PIXEL_SIZE;
    const viewW = w / TILE_PIXEL_SIZE;
    camera.left = -viewW / 2;
    camera.right = viewW / 2;
    camera.top = viewH / 2;
    camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  resize();

  return { renderer, scene, camera, resize };
}

/**
 * Restore the iso pose used by the title and battle scenes. Updates
 * both the camera transform and CAMERA_BASE_POSITION so the per-frame
 * screen-shake reset snaps back to the right anchor.
 */
export function setCameraIso() {
  applyPose(ISO_POSE);
}

/**
 * Aim the camera straight down. Use this for explore-style scenes
 * where WASD should map to N/S/E/W on a paper-map view.
 */
export function setCameraTopDown() {
  applyPose(TOP_DOWN_POSE);
}

/** @param {{ pos: { x: number, y: number, z: number }, up: { x: number, y: number, z: number } }} pose */
function applyPose(pose) {
  CAMERA_BASE_POSITION.x = pose.pos.x;
  CAMERA_BASE_POSITION.y = pose.pos.y;
  CAMERA_BASE_POSITION.z = pose.pos.z;
  if (!activeCamera) return;
  activeCamera.up.set(pose.up.x, pose.up.y, pose.up.z);
  activeCamera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  activeCamera.lookAt(0, 0, 0);
  activeCamera.updateProjectionMatrix();
}
