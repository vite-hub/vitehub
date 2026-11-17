/** `"all"` shows every comment on the page. `"hidden"` shows only the open thread, the draft, and a comment just sent. */
export type CommentVisibility = "all" | "hidden";

export interface CommentVisibilityOptions {
  /** The first value, such as one the reader saved. Default `"all"`. */
  visibility?: CommentVisibility;
  /** How long a comment or reply that was just sent shows while comments are hidden. The time waits while the reader is on it. Default `2500`. */
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
  /** The ids that stopped showing while comments are hidden, for `commentLeaveMs`. Their marks play the pop-out in that time. */
  readonly leaving: readonly string[];
  set: (visibility: CommentVisibility) => void;
  /** The thread that is open. It shows while comments are hidden. */
  open: (id: string | null) => void;
  /** Shows the thread for `flashMs` while comments are hidden. It does nothing while all show. */
  flash: (id: string) => void;
  /**
   * The thread the reader points at or focuses, such as its pin. `hover(null)` when the reader leaves. Like a toast, its
   * flash time stops while the reader is on it, and the rest of the time runs after.
   */
  hover: (id: string | null) => void;
  isShown: (id: string) => boolean;
  /** Calls `listener` after each change. Returns a function that stops it. */
  subscribe: (listener: () => void) => () => void;
  /** Clears the timers. Listeners stay until their own stop function. */
  stop: () => void;
}

/** How long a mark that stops showing stays, for its pop-out. The styles of the parts use the same time. */
export const commentLeaveMs = 130;

export function createCommentVisibility(options: CommentVisibilityOptions = {}): CommentVisibilityModel {
  const flashMs = options.flashMs ?? 2500;
  let visibility: CommentVisibility = options.visibility ?? "all";
  let opened: string | null = null;
  let hovered: string | null = null;
  let flashed: string[] = [];
  let only: readonly string[] = [];
  let leaving: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Each flash has a timer while it runs, or the time that is left while the reader is on it.
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flashEnds = new Map<string, number>();
  const flashPaused = new Map<string, number>();
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
  function stopFlashTimer(id: string): void {
    const timer = flashTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(timer);
    flashTimers.delete(id);
  }
  function runFlash(id: string, ms: number): void {
    stopFlashTimer(id);
    flashPaused.delete(id);
    if (id === hovered) {
      flashPaused.set(id, ms);
      return;
    }
    flashEnds.set(id, Date.now() + ms);
    flashTimers.set(id, later(() => {
      flashTimers.delete(id);
      flashEnds.delete(id);
      flashed = flashed.filter(entry => entry !== id);
      update();
    }, ms));
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
        for (const id of [...flashTimers.keys()]) stopFlashTimer(id);
        flashEnds.clear();
        flashPaused.clear();
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
      runFlash(id, flashMs);
      if (!flashed.includes(id)) {
        flashed = [...flashed, id];
        update();
      }
    },
    hover(id) {
      if (id === hovered) return;
      const left = hovered;
      hovered = id;
      if (left !== null) {
        const rest = flashPaused.get(left);
        if (rest !== undefined) runFlash(left, rest);
      }
      if (id !== null && flashTimers.has(id)) {
        const rest = Math.max(0, (flashEnds.get(id) ?? 0) - Date.now());
        stopFlashTimer(id);
        flashEnds.delete(id);
        flashPaused.set(id, rest);
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
      flashEnds.clear();
      flashPaused.clear();
      leaveTimers.clear();
    },
  };
}
