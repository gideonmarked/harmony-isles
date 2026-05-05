// @ts-check

import { Howl, Howler } from 'howler';

/**
 * Tiny audio wrapper around Howler. The only consumer right now is
 * the Perform rhythm minigame, which plays one song per round.
 *
 * Loading is lazy and fault-tolerant: the first call for a given
 * song id triggers a `Howl({ src: '/assets/audio/songs/<id>.mp3' })`,
 * which preloads. If the file is missing or fails to decode, the
 * audio system records the failure and treats subsequent plays as
 * no-ops — the game continues silent for that song without throwing.
 *
 * The `play()` API tries to start the song immediately if it's
 * loaded, otherwise it schedules a play once the load completes
 * (typically <100 ms behind for already-cached files). The slight
 * scheduling drift is acceptable for a single intro-track loop;
 * tighter sync would require pre-loading at scene enter.
 */

/**
 * @typedef {object} SongEntry
 * @property {Howl} howl
 * @property {boolean} loaded
 * @property {boolean} failed
 * @property {boolean} pendingPlay     true if play() was called before load completed
 * @property {number}  pendingFadeInMs fade-in to apply once load finishes (0 = none)
 */

/** @type {Map<string, SongEntry>} */
const songs = new Map();
/** Master volume for songs, 0..1. */
let masterVolume = 0.7;

/**
 * Get-or-create the cached entry for a song id. Triggers a load on
 * first request. Subsequent requests reuse the same Howl.
 *
 * @param {string} songId
 * @returns {SongEntry}
 */
function ensureSong(songId) {
  let entry = songs.get(songId);
  if (entry) return entry;
  const url = `/assets/audio/songs/${songId}.mp3`;
  /** @type {SongEntry} */
  const created = {
    howl: /** @type {any} */ (null),
    loaded: false,
    failed: false,
    pendingPlay: false,
    pendingFadeInMs: 0,
  };
  const howl = new Howl({
    src: [url],
    volume: masterVolume,
    html5: false,
    preload: true,
    onload: () => {
      created.loaded = true;
      if (created.pendingPlay) {
        created.pendingPlay = false;
        startWithFade(created, created.pendingFadeInMs);
        created.pendingFadeInMs = 0;
      }
    },
    onloaderror: () => {
      created.failed = true;
      created.pendingPlay = false;
      created.pendingFadeInMs = 0;
      // No console.warn — silent fallback is the design.
    },
  });
  created.howl = howl;
  songs.set(songId, created);
  return created;
}

/**
 * Begin playback of the named song. Stops any prior playback of the
 * same song first so a re-Perform doesn't layer audio over itself.
 * Optional fade-in ramps from 0 to masterVolume so the song doesn't
 * pop in cold.
 *
 * @param {string} songId
 * @param {{ fadeInMs?: number }} [opts]
 * @returns {Howl | null}  the playing Howl, or null if the file is missing
 */
export function playSong(songId, opts = {}) {
  const entry = ensureSong(songId);
  if (entry.failed) return null;
  const fadeInMs = Math.max(0, opts.fadeInMs ?? 0);
  if (!entry.loaded) {
    // Howler is still decoding — defer the play. The deferred path
    // re-applies the fade so a missing/slow file still ramps cleanly.
    entry.pendingPlay = true;
    entry.pendingFadeInMs = fadeInMs;
    return entry.howl;
  }
  startWithFade(entry, fadeInMs);
  return entry.howl;
}

/**
 * Internal: stop+restart the howl at zero volume, ramp to master
 * over `fadeInMs`. A 0 fade just plays at full volume immediately.
 *
 * @param {SongEntry} entry @param {number} fadeInMs
 */
function startWithFade(entry, fadeInMs) {
  entry.howl.stop();
  if (fadeInMs > 0) {
    entry.howl.volume(0);
    entry.howl.play();
    entry.howl.fade(0, masterVolume, fadeInMs);
  } else {
    entry.howl.volume(masterVolume);
    entry.howl.play();
  }
}

/**
 * Stop the named song. Optional fade-out ramps the volume to 0 over
 * `fadeOutMs` before halting playback so the song doesn't cut off
 * mid-bar. Safe to call on a never-loaded or unknown id.
 *
 * @param {string} songId
 * @param {{ fadeOutMs?: number }} [opts]
 */
export function stopSong(songId, opts = {}) {
  const entry = songs.get(songId);
  if (!entry) return;
  entry.pendingPlay = false;
  entry.pendingFadeInMs = 0;
  if (!entry.loaded) return;
  fadeOutAndStop(entry, Math.max(0, opts.fadeOutMs ?? 0));
}

/** @param {SongEntry} entry @param {number} fadeOutMs */
function fadeOutAndStop(entry, fadeOutMs) {
  if (fadeOutMs <= 0) {
    entry.howl.stop();
    return;
  }
  const startVol = entry.howl.volume();
  entry.howl.fade(startVol, 0, fadeOutMs);
  // Hard-stop after the ramp so the howl is fully released even if
  // the player triggers another Perform mid-fade.
  setTimeout(() => entry.howl.stop(), fadeOutMs + 30);
}

/**
 * Stop every song known to the cache. Use on scene exit so audio
 * doesn't leak across transitions.
 *
 * @param {{ fadeOutMs?: number }} [opts]
 */
export function stopAllSongs(opts = {}) {
  const fadeOutMs = Math.max(0, opts.fadeOutMs ?? 0);
  for (const entry of songs.values()) {
    entry.pendingPlay = false;
    entry.pendingFadeInMs = 0;
    if (entry.loaded) fadeOutAndStop(entry, fadeOutMs);
  }
}

// ──────────────────────────── BGM ────────────────────────────────
//
// Looping background music — one track at a time. Scenes call
// playBgm() on enter, stopBgm() on exit (or transition declares a
// new track via playBgm with a different id, triggering a
// crossfade). Mute/unmute lets battle dip the BGM during a Perform
// rhythm round without stopping playback so it can resume cleanly
// when the round ends.

/**
 * @typedef {object} BgmEntry
 * @property {Howl} howl
 * @property {boolean} loaded
 * @property {boolean} failed
 * @property {string}  id
 * @property {number}  targetVolume    where unmute / non-muted plays settle
 */

/** @type {Map<string, BgmEntry>} */
const bgmCache = new Map();
/** Whichever BGM is currently the "active" track. May still be
 *  fading in if its file is still loading. */
let currentBgm = /** @type {BgmEntry | null} */ (null);
/** When true, BGM is held at volume 0 regardless of target. */
let bgmMuted = false;

/**
 * Get-or-create the cached BgmEntry for a track id.
 *
 * @param {string} id
 * @returns {BgmEntry}
 */
function ensureBgm(id) {
  let entry = bgmCache.get(id);
  if (entry) return entry;
  const url = `/assets/audio/bgm/${id}.mp3`;
  /** @type {BgmEntry} */
  const created = {
    howl: /** @type {any} */ (null),
    loaded: false,
    failed: false,
    id,
    targetVolume: masterVolume,
  };
  const howl = new Howl({
    src: [url],
    loop: true,
    volume: 0,
    html5: false,
    preload: true,
    onload: () => {
      created.loaded = true;
    },
    onloaderror: () => {
      created.failed = true;
    },
  });
  created.howl = howl;
  bgmCache.set(id, created);
  return created;
}

/**
 * Play (or switch to) the named BGM track. Calling with a different
 * id while another BGM is playing crossfades the two. Calling with
 * the same id just retunes the target volume (no restart).
 *
 * @param {string} id
 * @param {{ volume?: number, fadeInMs?: number }} [opts]
 */
export function playBgm(id, opts = {}) {
  const fadeInMs = Math.max(0, opts.fadeInMs ?? 600);
  const targetVolume = Math.max(0, Math.min(1, opts.volume ?? masterVolume));
  const entry = ensureBgm(id);
  if (entry.failed) {
    // Missing file — silent. Still mark as current so a later
    // unmute / stop call doesn't leak ops onto the prior track.
    currentBgm = entry;
    return;
  }
  entry.targetVolume = targetVolume;

  // Same track already playing — just retune the target volume.
  if (currentBgm === entry) {
    if (entry.loaded && !bgmMuted) {
      entry.howl.fade(entry.howl.volume(), targetVolume, fadeInMs);
    }
    return;
  }

  // Different track — fade out the previous one concurrently.
  if (currentBgm) {
    const prev = currentBgm;
    if (prev.loaded) {
      const fromVol = prev.howl.volume();
      prev.howl.fade(fromVol, 0, fadeInMs);
      setTimeout(() => prev.howl.stop(), fadeInMs + 30);
    }
  }

  // Switching tracks clears any lingering mute. The mute flag is
  // tied to the current BGM session (e.g. dipping during a Perform);
  // a fresh track should default to its target volume.
  bgmMuted = false;
  currentBgm = entry;

  /** Start (or restart) playback at zero, then fade in. */
  const startPlayback = () => {
    // If the user kicked off another playBgm before this one's
    // load completed, abandon — don't yank the new track off.
    if (currentBgm !== entry) return;
    entry.howl.volume(0);
    if (!entry.howl.playing()) entry.howl.play();
    entry.howl.fade(0, bgmMuted ? 0 : targetVolume, fadeInMs);
  };

  if (entry.loaded) {
    startPlayback();
  } else {
    // Wait once for the decode; multiple pending plays piggyback
    // on one listener since they all settle the same way.
    entry.howl.once('load', startPlayback);
  }
}

/**
 * Fade out the active BGM (if any) and stop it.
 *
 * @param {{ fadeOutMs?: number }} [opts]
 */
export function stopBgm(opts = {}) {
  const fadeOutMs = Math.max(0, opts.fadeOutMs ?? 400);
  const entry = currentBgm;
  currentBgm = null;
  if (!entry || !entry.loaded) return;
  if (fadeOutMs <= 0) {
    entry.howl.stop();
    return;
  }
  const fromVol = entry.howl.volume();
  entry.howl.fade(fromVol, 0, fadeOutMs);
  setTimeout(() => entry.howl.stop(), fadeOutMs + 30);
}

/**
 * Dip BGM volume to 0 without stopping playback. The track keeps
 * playing silently in the background so {@link unmuteBgm} can ramp
 * it back up without restarting from frame 0.
 *
 * @param {{ fadeMs?: number }} [opts]
 */
export function muteBgm(opts = {}) {
  bgmMuted = true;
  const fadeMs = Math.max(0, opts.fadeMs ?? 200);
  if (!currentBgm || !currentBgm.loaded) return;
  currentBgm.howl.fade(currentBgm.howl.volume(), 0, fadeMs);
}

/**
 * Restore BGM volume to the entry's target. Counterpart to
 * {@link muteBgm}; safe to call even when not muted (no-op).
 *
 * @param {{ fadeMs?: number }} [opts]
 */
export function unmuteBgm(opts = {}) {
  bgmMuted = false;
  const fadeMs = Math.max(0, opts.fadeMs ?? 200);
  if (!currentBgm || !currentBgm.loaded) return;
  currentBgm.howl.fade(
    currentBgm.howl.volume(),
    currentBgm.targetVolume,
    fadeMs
  );
}

/**
 * Adjust master volume for songs played afterwards. Existing Howls
 * also retune so a slider mid-song reflects immediately.
 *
 * @param {number} v  0..1
 */
export function setSongVolume(v) {
  masterVolume = Math.max(0, Math.min(1, v));
  for (const entry of songs.values()) entry.howl.volume(masterVolume);
}

// ─────────────────────── Global volume / mute ────────────────────
//
// Layered on top of every Howl in the app: Howler.volume() and
// Howler.mute() apply a multiplier across all sounds simultaneously,
// so this is what the on-screen audio buttons control. Per-track
// volumes (BGM 0.5, etc) still apply — the global value scales them.

const VOLUME_LS_KEY = 'hi.audio.volume';
const MUTED_LS_KEY = 'hi.audio.muted';

let globalVolume = 1.0;
let globalMuted = false;

// Restore persisted values from a prior session, if any.
try {
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(VOLUME_LS_KEY);
    if (v != null) {
      const parsed = parseFloat(v);
      if (Number.isFinite(parsed)) {
        globalVolume = Math.max(0, Math.min(1, parsed));
      }
    }
    if (localStorage.getItem(MUTED_LS_KEY) === '1') globalMuted = true;
  }
} catch {
  // localStorage may be unavailable (private mode, file://) — fall
  // back to defaults silently.
}
Howler.volume(globalVolume);
Howler.mute(globalMuted);

/**
 * Set the global volume multiplier. Affects every currently-playing
 * sound and every future one. Persisted to localStorage so the user's
 * setting survives reloads.
 *
 * @param {number} v  0..1, clamped
 */
export function setGlobalVolume(v) {
  globalVolume = Math.max(0, Math.min(1, v));
  Howler.volume(globalVolume);
  try {
    localStorage?.setItem(VOLUME_LS_KEY, String(globalVolume));
  } catch {
    // ignore — non-persistent is acceptable
  }
}

/** @returns {number} */
export function getGlobalVolume() {
  return globalVolume;
}

/**
 * Toggle global mute. The volume value is preserved underneath so
 * unmuting restores it without a separate state.
 *
 * @param {boolean} muted
 */
export function setGlobalMute(muted) {
  globalMuted = !!muted;
  Howler.mute(globalMuted);
  try {
    localStorage?.setItem(MUTED_LS_KEY, globalMuted ? '1' : '0');
  } catch {
    // ignore
  }
}

/** @returns {boolean} */
export function isGlobalMuted() {
  return globalMuted;
}
