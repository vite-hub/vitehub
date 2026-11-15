/** `"all"` shows every comment on the page. `"hidden"` shows only the open thread, the draft, and a comment just sent. */
export type CommentVisibility = "all" | "hidden";

export interface CommentVisibilityOptions {
  /** The first value, such as one the reader saved. Default `"all"`. */
  visibility?: CommentVisibility;
  /** How long a comment or reply that was just sent shows while comments are hidden. Default `2500`. */
  flashMs?: number;
}

/**
 * Which comments show on the page, with no framework. `useComments()` keeps one, and a page that draws its marks
 * somewhere else, such as in a frame, can keep its own and send `only` there.
 */
export interface CommentVisibilityModel {
  readonly visibility: CommentVisibility;
  /** The ids that still show while comments are hidden: the open thread, then each one that was just sent. Empty while all show. */
  readonly only: readonly string[];
  /** The ids that stopped showing while comments are hidden, for 180 ms. Their marks play the pop-out in that time. */
  readonly leaving: readonly string[];
  set: (visibility: CommentVisibility) => void;
  /** The thread that is open. It shows while comments are hidden. */
  open: (id: string | null) => void;
  /** Shows the thread for `flashMs` while comments are hidden. It does nothing while all show. */
  flash: (id: string) => void;
  isShown: (id: string) => boolean;
  /** Calls `listener` after each change. Returns a function that stops it. */
  subscribe: (listener: () => void) => () => void;
  /** Clears the timers. Listeners stay until their own stop function. */
  stop: () => void;
}

/** How long a mark that stops showing stays, for its pop-out. The styles of the parts use the same time. */
export const commentLeaveMs = 180;

export function createCommentVisibility(options: CommentVisibilityOptions = {}): CommentVisibilityModel {
  const flashMs = options.flashMs ?? 2500;
  let visibility: CommentVisibility = options.visibility ?? "all";
  let opened: string | null = null;
  let flashed: string[] = [];
  let only: readonly string[] = [];
  let leaving: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const leaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();

  const later = (run: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };
  function update(): void {
    const before = only;
    only = visibility === "hidden" ? [...new Set([...(opened ? [opened] : []), ...flashed])] : [];
    // A mark leaves with a pop-out only while comments stay hidden. Hiding all of them at once is the reader's choice.
    const gone = visibility === "hidden" ? before.filter(id => !only.includes(id)) : [];
    leaving = visibility === "hidden" ? [...leaving.filter(id => !only.includes(id)), ...gone.filter(id => !leaving.includes(id))] : [];
    for (const id of gone) {
      clearTimeout(leaveTimers.get(id));
      leaveTimers.set(id, later(() => {
        leaveTimers.delete(id);
        leaving = leaving.filter(entry => entry !== id);
        for (const listener of listeners) listener();
      }, commentLeaveMs));
    }
    for (const listener of listeners) listener();
  }

  return {
    get visibility() {
      return visibility;
    },
    get only() {
      return only;
    },
    get leaving() {
      return leaving;
    },
    set(next) {
      if (next === visibility) return;
      visibility = next;
      if (next === "all") {
        for (const timer of flashTimers.values()) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        flashTimers.clear();
        flashed = [];
      }
      update();
    },
    open(id) {
      if (id === opened) return;
      opened = id;
      update();
    },
    flash(id) {
      if (visibility !== "hidden") return;
      // A second flash of the same thread starts its time again.
      const before = flashTimers.get(id);
      if (before) {
        clearTimeout(before);
        timers.delete(before);
      }
      flashTimers.set(id, later(() => {
        flashTimers.delete(id);
        flashed = flashed.filter(entry => entry !== id);
        update();
      }, flashMs));
      if (!flashed.includes(id)) {
        flashed = [...flashed, id];
        update();
      }
    },
    isShown: id => visibility === "all" || only.includes(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      flashTimers.clear();
      leaveTimers.clear();
    },
  };
}
