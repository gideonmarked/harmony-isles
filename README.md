# Harmony Isles

An isometric pixel-art rhythm RPG. You play a band manager exploring floating islands, recruiting musicians, and battling rivals in rhythm-based Jam Clashes.

## Status

Pre-alpha — vertical slice for the vibe-coding hackathon (May 2026 submission). The slice ships a single playable Jam Clash with the Band Performance limit-break; full demo content (overworld, shop, save profiles, additional islands and characters) is post-hackathon.

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

Opens the dev server at `http://localhost:5173` (or `5174` if 5173 is busy). Press `Z` on the title screen to start a Jam Clash.

## Controls

### Title
| Key | Action |
| --- | --- |
| `Z` | Start a Jam Clash |

### Jam Clash — your turn
| Key | Action |
| --- | --- |
| `Z` | Perform Final Encore (rhythm minigame) |
| `X` | Trigger Band Performance limit-break (Hype must be at 100) |
| `Esc` | Abandon battle, return to title |

### Jam Clash — rhythm minigame
| Key | Action |
| --- | --- |
| `D` | Hit a note in lane 1 |
| `F` | Hit a note in lane 2 |
| `J` | Hit a note in lane 3 |
| `K` | Hit a note in lane 4 |

Notes fall toward the hit zone at the bottom of each lane. Hitting a note within ±90 ms of its scheduled time scores Perfect; within ±200 ms scores Good; outside that is a Miss. Accuracy weights the perform damage and Hype gain on resolve.

### Debug shortcuts (player turn only)

These are testing aids — judges aren't holding Shift, so they don't trigger by accident during a normal play.

| Chord | Action |
| --- | --- |
| `Shift + H` | Fill Hype to 100 |
| `Shift + K` | KO the enemy instantly |

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
    inputManager.js       keyboard input with modifier propagation
    sceneManager.js       scene lifecycle (enter/update/exit)
    rhythmEngine.js       rhythm grading, note scheduling, accuracy
    timeFx.js             hit-pause + screen-shake utilities
  scenes/
    titleScene.js         title screen, Z to start
    battleScene.js        Jam Clash arena and turn machine
  entities/
    character.js          player/enemy combatants with stats
  ui/
    battleHud.js          DOM HUD (HP bars, Hype meter, prompt)
    rhythmUI.js           DOM lanes + falling notes overlay
    battleFx.js           BAND PERFORMANCE / VICTORY / DEFEAT banners
  util/
    rng.js                seeded mulberry32 PRNG
  configs/
    main.json             root config (rng seed, audio defaults)
    songs.json            note patterns for Final Encore + LIMIT BREAK
public/
  assets/                 sprites, audio, maps (populated when assets land)
```

## AI usage

This project is a vibe-coding hackathon entry — the rule is **≥90 % AI-generated code**, written with Claude (Sonnet/Opus) as the primary author and human steering for direction, scope, and review. Commit history is the audit trail.
