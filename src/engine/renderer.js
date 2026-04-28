// @ts-check

import * as THREE from 'three';

const VIEW_SIZE = 12;

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

  const aspect = window.innerWidth / window.innerHeight;
  const camera = new THREE.OrthographicCamera(
    (-VIEW_SIZE * aspect) / 2,
    (VIEW_SIZE * aspect) / 2,
    VIEW_SIZE / 2,
    -VIEW_SIZE / 2,
    0.1,
    1000
  );
  camera.position.set(20, 20, 20);
  camera.lookAt(0, 0, 0);

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
    const a = w / h;
    camera.left = (-VIEW_SIZE * a) / 2;
    camera.right = (VIEW_SIZE * a) / 2;
    camera.top = VIEW_SIZE / 2;
    camera.bottom = -VIEW_SIZE / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  resize();

  return { renderer, scene, camera, resize };
}
