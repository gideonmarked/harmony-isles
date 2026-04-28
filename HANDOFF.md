# Handoff — Justin → Gideon

Internal handoff notes. Slice is feature-complete on the systems side. Your remaining work is asset integration, the audio sync proof, and submission polish.

## Status snapshot (2026-04-28)

- 26 commits on `main`. Lint clean, build passes, no console errors in dev.
- `npm install && npm run dev` opens a fully playable Jam Clash with Manager Style picker, song select, items, defend, Band Performance, and victory/defeat states.
- All controls documented in `README.md`; debug shortcuts (`Shift+H`, `Shift+K`) are wired for fast testing.
- Design doc stays out of the repo per agreement (gitignored).

## What's shipped (slice contents)

### Foundations
- Vite + Three.js orthographic-isometric renderer
- ESLint flat config + Prettier + JSDoc + `tsconfig.json` (`checkJs: true`)
- EventBus, GameAction reducer, ConfigService (Vite glob import), AudioManager (Howler + AudioContext clock), InputManager (keyboard + modifier propagation), SceneManager, seeded RNG
- Pinned Node 20 (`.nvmrc`)

### Title flow (`src/scenes/titleScene.js`)
- HARMONY ISLES branding, "Choose a Manager Style" prompt
- Five archetype cards per design doc §8.1: **The Hustler · The Visionary · The Coach · The Showrunner · The Mentor**
- Doc-verbatim summary/tradeoff text on each card
- Keys `1`–`5` quick-select, arrows + `Enter`/`Z` confirm

### Battle scene (`src/scenes/battleScene.js`)
- State machine: `introducing → playerTurn → {performing | itemMenu | songMenu | resolving} → enemyTurn → gameOver`
- Random rival roster (5 templates, role-based stats per §9.2, rarity multiplier per §7.2, tinted mesh)
- JAM CLASH! encounter telegraph splash on enter (§2.2 + §32)
- Action menu: `Z` Perform · `X` Band Performance (Hype = 100) · `C` Defend · `I` Items · `Esc` to title
- Per-rival defeat / victory dialogue lines
- §15.1 full damage formula:
  ```
  damage = max(1, round(
      song.basePower
    × scaleStat
    × accuracyMultiplier
    × criticalMultiplier
    × statusBuffMultiplier
    × jitter(0.95, 1.05)
    / confidenceDefense(target, defending)
  ))
  ```

### Rhythm engine (`src/engine/rhythmEngine.js`)
- Four-tier grading per §14.3: Perfect (≤90 ms) / Good (≤170 ms) / Okay (≤260 ms) / Miss
- Accuracy weights: 1.0 / 0.7 / 0.4 / 0 (per §14.3)
- Per-note "Bull's-eye" promotion inside ±30 ms (visual hook only — the doc's 1.5× criticalMultiplier is computed song-wide on `result.flawless`)
- Streak counter (survives Okay, resets on Miss)
- Technicality widens Perfect window per §1.3 (`(tech - 11) × 2 ms`)
- Clock source is injected — currently `performance.now() / 1000`; **swap to `audioManager.getAudioTime()` once a song file lands**

### Songs (`src/configs/songs.json`)
- All 7 songs from §16: Neon Riff, Bass Pulse, Drum Fury, Echo Harmony, Silent Drop, Sonic Rush, Final Encore
- Doc-verbatim metadata: power, scalesOff, energy cost, BPM, duration
- Hand-authored note patterns (4-lane); ready for real audio swap

### Items (`src/configs/items.json`)
- All 5 consumables from §20: Energy Drink, Focus Pill, Groove Booster, Confidence Badge, Creative Spark
- Doc-verbatim buy/sell prices, durations, effects
- Confidence Badge restores HP; Creative Spark and friends apply multiplicative buffs that stack with Manager Style and the §15 damage chain

### Manager Style (`src/configs/managerStyles.json`)
- All 5 styles from §8.1 with full effect payload
- Active in slice: Visionary (creativityStatMult 1.15), Coach (damageMult 0.9), Showrunner (hypeGainMult 1.25 + bandPerformanceDamageMult 1.15)
- Inert in slice but data-correct for later: Hustler (Notes), Mentor (recruitment)

### Band Performance
- Triggers on `X` when Hype reaches max
- Plays Final Encore (denser pattern, ~13 s, 47 notes at 130 BPM)
- 2.4× song basePower per §16; Showrunner adds +15 % on top
- Resets Hype to 0 on completion
- Visual: warm orange tint on lanes, "BAND PERFORMANCE!" banner with flash + vignette

### Juice (`src/engine/timeFx.js` + `src/ui/battleFx.js`)
- Hit-pause (60–140 ms) on damage, scaled by hit size
- Camera shake on damage and KO
- BAND PERFORMANCE banner, VICTORY / DEFEATED banners, JAM CLASH encounter splash
- Hype meter pulses + shimmers when full
- Hit zone flashes (Perfect / Good / Okay / Miss / Crit) per lane

### HUD (`src/ui/battleHud.js`)
- Player + rival HP bars (top corners)
- Hype meter (bottom centre, pulses at full)
- Prompt panel (action menu / round result / dialogue)

## Remaining work

### Audio integration

Swap the rhythm engine clock from wall time to the AudioContext. One-line change plus song-file paths. Concrete steps:

1. Drop the song loop into `public/assets/audio/songs/finalEncore.{mp3,ogg}` (and others as you author them — file basenames should match config IDs, e.g. `neonRiff.mp3`).
2. In `src/main.js` (or a new boot helper), call:
   ```js
   audioManager.register('finalEncore', { src: '/assets/audio/songs/finalEncore.mp3' });
   ```
   for each song you want playable.
3. In `src/scenes/battleScene.js`, in `startPerformWithSong`, replace:
   ```js
   rhythm = startRhythm(pattern, () => (performance.now() - rhythmStartMs) / 1000, …);
   ```
   with:
   ```js
   audioManager.play(songId);
   const audioStart = audioManager.getAudioTime();
   rhythm = startRhythm(pattern, () => audioManager.getAudioTime() - audioStart, …);
   ```
   That makes the AudioContext clock the master per §3 / §27.
4. Calibrate per-device offset: tweak `audio.offsetMs` in `src/configs/main.json` if the rhythm feels early/late after audio is wired. (Future work: ship the doc's offset-calibration sub-mode, §32.)

### SFX

Register hit / miss / KO / victory tones in `audioManager` and trigger from EventBus subscriptions:

```js
// On boot
audioManager.register('sfxHitPerfect', { src: '/assets/audio/sfx/hit_perfect.wav', volume: 0.6 });
audioManager.register('sfxHitGood',    { src: '/assets/audio/sfx/hit_good.wav',    volume: 0.5 });
audioManager.register('sfxMiss',       { src: '/assets/audio/sfx/miss.wav',        volume: 0.4 });
audioManager.register('sfxKo',         { src: '/assets/audio/sfx/ko.wav',          volume: 0.7 });

// Wire reactions
eventBus.on('rhythm.noteJudged', ({ grade }) => {
  audioManager.play(`sfxHit${grade === 'perfect' ? 'Perfect' : grade === 'good' ? 'Good' : 'Miss'}`);
});
eventBus.on('battle.gameOver', ({ outcome }) => {
  audioManager.play(outcome === 'victory' ? 'sfxKo' : 'sfxMiss');
});
```

### Asset slots

| Slot | Path | Format | Notes |
| --- | --- | --- | --- |
| Player sprite | `public/assets/sprites/player/{idle,attack,ko}.png` | PNG atlas | Replaces the blue placeholder cuboid in `Character.mesh`. To swap: change the geometry in `src/entities/character.js` to a `PlaneGeometry` + `THREE.SpriteMaterial` and load the texture via `THREE.TextureLoader`. Animation loop already exists — just needs frame-cycling instead of bobbing a box. |
| Rival sprites | `public/assets/sprites/rivals/{rivalId}/{idle,attack,ko}.png` | PNG atlas | Five rival ids in `src/configs/rivals.json` (`riffLord`, `lowEndDemon`, `beatSmith`, `synthWizard`, `vocalStorm`). |
| Tilemap | `public/assets/maps/arena.json` (Tiled JSON) | JSON | Replaces the green plane in `src/engine/renderer.js`. |
| Songs | `public/assets/audio/songs/{songId}.{mp3,ogg}` | MP3/OGG | Seven ids in `src/configs/songs.json`. |
| SFX | `public/assets/audio/sfx/{name}.wav` | WAV | Names suggested above. |

The asset-loading fallback (per §27) is not implemented yet — when a sprite is missing the placeholder mesh stays. Add a try/catch around `TextureLoader` calls if you want the fallback to be loud.

### Submission packaging

- [ ] `npm run build` clean
- [ ] Demo video (60–90 s, shows: title → style pick → battle → song select → rhythm → BP → victory dialogue)
- [ ] README's AI-usage note still accurate (currently states "≥90 % AI-generated, commit history is the audit trail")
- [ ] Submission form filled with repo URL + video link before May 1 cutoff

## Held off

Doc-explicit features that are not in this build, organized by category. Most are explicit post-slice per the doc itself; none are regressions. Listed so the gap is legible at a glance.

### Asset-blocked
- Music — songs exist as note patterns in `src/configs/songs.json`; no audio files yet.
- SFX — hit / miss / KO / victory tones not registered.
- Sprites — characters are colored boxes, ground is a green plane.
- Aseprite frame animations — code has hooks (idle bob, attack lunge, KO drop) but cycles a `BoxGeometry` rather than real frames.

### Doc-spec systems not in this build

| Feature | Doc § |
| --- | --- |
| Overworld walking, 10 themed islands + 1 shop island | §3 + §6 |
| Random encounter system (rarity-tiered telegraphs, pity floor) | §12 + §23 |
| Shop (Islands / Instruments / Items / Songs tabs, buy/sell) | §25 |
| Save system (3 LocalStorage profiles) | §26 |
| Recruitment math (join chance, recruitment roll) | §24 |
| Chemistry tracking + scripted reveal | §8.3 |
| 8 Personalities with stat / Hype effects | §8.2 |
| 25 Instruments (5 categories × 5 tiers) | §19 |
| Manager Journal + 7 demo quests | §2.3 |
| Tutorial flow | §32 |
| Practice Mode + audio offset calibration sub-mode | §32 |
| 15 character designs (3 per role) | §7.1 (slice has 5 rivals, 1 per role) |
| Random naming generator | §7.3 |
| Per-character rarity visuals (glow / halo / particles) | §7.2 |
| Day / night cycle visuals | §33.5 |
| Defeat dialogue tables in `en.json` | §32 (slice has inline lines, no i18n) |

### Battle math not in this build

| Mechanic | Doc § |
| --- | --- |
| Dodge / evasion roll on every incoming attack | §14.4 + §22 |
| Flee action | §33.2 (slice has Perform / Defend / Items only) |
| Status effects (Standing Ovation, song buffs / debuffs) | §21 |
| Multi-target song resolution (`all_band`, `all_rivals`) | §16 |
| Echo Harmony's true `all_band` heal | §16.4.1 (heals player only — slice has one character on-side) |
| Silent Drop debuff effect | §16.4.2 (treated as attack damage in slice) |
| Hype critical bonus (+3 on flawless / +2 on dodge) | §22 |
| Rarity damage multiplier in formula | §15.1 (defaults to 1.0; `rarityMultiplierFor` exists but applies only to rival stat scaling) |
| Equipment bonus in formula | §15.1 (defaults to 1.0) |
| Rank progression / exp / level-up | §11 (both characters fixed at rank 1) |

### Manager Style effects inert in this build

Stored in `src/configs/managerStyles.json` so the picker matches the doc, but their target systems aren't shipped yet:

- **Hustler** — Notes earned, weekly payout, recruitment chance
- **Mentor** — recruit chance bonus, rare+ spawn weight, Tier-3+ instrument prices
- **Visionary** — songs cost 25 % less MP (Energy is deducted but never blocking), confidence growth slower (no inter-battle regen)
- **Coach** — exp gain, confidence regen between battles
- **Showrunner** — Notes earned

### Hackathon-cut

- Tests (no Vitest config)
- CI (no GitHub Actions)
- Husky / lint-staged
- Asset-loading fallback (per §27)
- Mod loader overlay (configs eagerly imported via `import.meta.glob`; no `/mods/` deepMerge layer)
- Telemetry hooks
- Bounding-box debug renderer

## Known risks

1. **Audio sync drift** — until a real song plays, we don't actually know how tight the AudioContext + visual frame sync is on real devices. Plan to budget 30–60 min for a per-device offset pass.
2. **Single-song demo path** — if you only ship audio for Final Encore, hide the other 6 songs in the picker (or lock them behind `Cred req.` per the doc). Otherwise judges can pick a silent song.
3. **Long sessions surface ordering bugs** — only smoke-tested. KO during BP, item-while-defending, etc. probably need a 10-minute play pass.

## Code map

| Concern | Where |
| --- | --- |
| Boot sequence | `src/main.js` |
| Iso renderer + camera | `src/engine/renderer.js` |
| Pub/sub bus | `src/engine/eventBus.js` |
| State + reducer | `src/engine/gameState.js` |
| JSON config registry | `src/engine/configService.js` |
| Howler + audio clock | `src/engine/audioManager.js` |
| Keyboard input | `src/engine/inputManager.js` |
| Scene lifecycle | `src/engine/sceneManager.js` |
| Rhythm grading | `src/engine/rhythmEngine.js` |
| Hit-pause / shake | `src/engine/timeFx.js` |
| Title + style picker | `src/scenes/titleScene.js` |
| Battle scene + state machine | `src/scenes/battleScene.js` |
| Player / rival entity | `src/entities/character.js` |
| HUD overlay | `src/ui/battleHud.js` |
| Rhythm lanes overlay | `src/ui/rhythmUI.js` |
| Banners / vignette | `src/ui/battleFx.js` |
| Item submenu | `src/ui/itemMenu.js` |
| Song picker | `src/ui/songMenu.js` |
| Songs / Items / Styles / Rivals data | `src/configs/*.json` |

## Conventions to keep

- Conventional Commits with capitalized subject and a descriptive body (see existing log).
- No `Co-Authored-By: Claude` trailer — keep commit attribution clean.
- ESLint clean before pushing (`npm run lint`).
- New systems wire through EventBus; don't import a system from another system directly.
- All randomness through the seeded RNG when determinism matters; `Math.random()` is fine for cosmetic jitter.

Ping me on Slack / Discord if anything bites. Otherwise — go make it look like a game.
