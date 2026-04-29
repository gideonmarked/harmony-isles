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
   * Snapshots the handler set before iterating so that subscribers
   * registered DURING dispatch (e.g. opening a UI overlay in
   * response to a keypress) do not receive the same event that
   * triggered them. Without this, pressing "B" to open the shop
   * would also close it, since the shop's freshly-added handler
   * would see the still-in-flight "B" keydown.
   *
   * @template P
   * @param {string} event
   * @param {P} [payload]
   */
  emit(event, payload) {
    const set = this.#handlers.get(event);
    if (!set) return;
    const snapshot = [...set];
    for (const fn of snapshot) {
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
