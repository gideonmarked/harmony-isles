# Harmony Isles

An isometric pixel-art rhythm RPG. You play a band manager exploring floating islands, recruiting musicians, and battling rivals in rhythm-based Jam Clashes.

## Status

Pre-alpha foundation. Hackathon submission build in progress.

## Stack

- **Three.js** — orthographic-isometric rendering
- **Vite** — bundler and dev server
- **Vanilla JS (ESM) + JSDoc** — type-checked via `tsconfig.json` (`checkJs: true`), no TypeScript build step
- **Howler.js + AudioContext** — audio playback and rhythm-engine clock
- **ESLint flat config + Prettier** — formatting and lint

## Getting started

Requires Node 20 (see `.nvmrc`).

```bash
npm install
npm run dev
```

Opens the dev server at `http://localhost:5173`. The current scene is a placeholder isometric tile + debug cube to verify the renderer.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint over the source tree |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run format` | Prettier write |

## Project layout

```
src/
  main.js                 entrypoint, boot sequence, render loop
  engine/
    renderer.js           Three.js orthographic-iso camera + scene
    eventBus.js           pub/sub for cross-system communication
    gameState.js          GameAction reducer (immutable updates)
    configService.js      JSON config loader (Vite glob import)
    audioManager.js       Howler wrapper + AudioContext clock
    inputManager.js       keyboard input
    sceneManager.js       scene lifecycle (enter/update/exit)
  util/
    rng.js                seeded mulberry32 PRNG
  configs/
    main.json             root config (rng seed, audio defaults)
public/
  assets/                 sprites, audio, maps (populated by Gideon)
```
