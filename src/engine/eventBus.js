// @ts-check

/**
 * @template [P=unknown]
 * @typedef {(payload: P) => void} EventHandler
 */

/**
 * Pub/sub event bus. Systems publish events they care about; other
 * systems subscribe. No system imports another system directly —
 * they meet at the bus.
 */
class EventBus {
  /** @type {Map<string, Set<EventHandler<any>>>} */
  #handlers = new Map();

  /**
   * Subscribe to an event. Returns an unsubscribe function so callers
   * can clean up without holding onto the handler reference.
   *
   * @template P
   * @param {string} event
   * @param {EventHandler<P>} fn
   * @returns {() => void}
   */
  on(event, fn) {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Emit an event. Errors in one handler do not stop the others.
   *
   * @template P
   * @param {string} event
   * @param {P} [payload]
   */
  emit(event, payload) {
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`EventBus handler for "${event}" threw:`, e);
      }
    }
  }

  /**
   * Remove all subscribers for a single event, or for every event
   * when called without an argument.
   *
   * @param {string} [event]
   */
  clear(event) {
    if (event) {
      this.#handlers.delete(event);
    } else {
      this.#handlers.clear();
    }
  }
}

/** Process-wide event bus. */
export const eventBus = new EventBus();
