// @ts-check

import { Howl, Howler } from 'howler';

/**
 * Wrapper around Howler for sample playback plus an accessor for the
 * AudioContext clock used by the rhythm engine.
 *
 * Howler shares a single AudioContext across all sounds (`Howler.ctx`).
 * The rhythm system schedules notes against this clock — never use
 * `performance.now()` for note timing, since only the audio clock is
 * monotonic with the audio output device.
 */
class AudioManager {
  /** @type {Map<string, Howl>} */
  #sounds = new Map();

  /**
   * Register a sound by id. `src` is a URL relative to the public root
   * (e.g. `/assets/audio/songs/encore.mp3`).
   *
   * @param {string} id
   * @param {{ src: string | string[], loop?: boolean, volume?: number }} opts
   */
  register(id, opts) {
    const sources = Array.isArray(opts.src) ? opts.src : [opts.src];
    this.#sounds.set(
      id,
      new Howl({
        src: sources,
        loop: opts.loop ?? false,
        volume: opts.volume ?? 1,
        preload: true,
      })
    );
  }

  /**
   * @param {string} id
   * @returns {number | undefined}  Howler playback id (use to stop a specific instance).
   */
  play(id) {
    const sound = this.#sounds.get(id);
    if (!sound) {
      console.warn(`AudioManager: unknown sound "${id}"`);
      return undefined;
    }
    return sound.play();
  }

  /** @param {string} id */
  stop(id) {
    this.#sounds.get(id)?.stop();
  }

  stopAll() {
    for (const sound of this.#sounds.values()) sound.stop();
  }

  /**
   * Master AudioContext clock. Returns 0 until Howler has unlocked the
   * context (browsers require a user gesture to start audio).
   *
   * @returns {number}  Seconds since the AudioContext started.
   */
  getAudioTime() {
    return Howler.ctx?.currentTime ?? 0;
  }

  /** @param {number} v  Master volume 0..1. */
  setMasterVolume(v) {
    Howler.volume(v);
  }
}

export const audioManager = new AudioManager();
