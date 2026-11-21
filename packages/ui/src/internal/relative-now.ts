import { type InjectionKey, type Ref, ref } from "vue";

/** The clock that `RelativeTime` counts from, given by `provideRelativeNow()`. */
export const relativeNowKey: InjectionKey<Readonly<Ref<number>>> = Symbol("ViteHubRelativeNow");

/** How often the clock moves. The words change by the minute at most, so twice a minute is enough. */
export const relativeNowInterval = 30_000;

/**
 * Sets `now` to the browser clock, then again every 30 s while the page is visible. A hidden page stops the timer, and
 * the page showing again moves the clock at once. Returns the function that stops it.
 */
export function startRelativeClock(now: Ref<number>): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => (now.value = Date.now());
  const pause = () => clearInterval(timer);
  const resume = () => {
    pause();
    tick();
    timer = setInterval(tick, relativeNowInterval);
  };
  const onVisibility = () => (document.visibilityState === "hidden" ? pause() : resume());
  document.addEventListener("visibilitychange", onVisibility);
  onVisibility();
  return () => {
    pause();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

// The clock of an app that gives none. It runs while at least one RelativeTime is mounted.
const shared = ref(0);
let holders = 0;
let stopShared: (() => void) | undefined;

/** Starts the shared clock for a mounted `RelativeTime`. Call `releaseSharedNow()` when it unmounts. */
export function holdSharedNow(): Readonly<Ref<number>> {
  if (holders++ === 0) stopShared = startRelativeClock(shared);
  return shared;
}

export function releaseSharedNow(): void {
  if (--holders === 0) stopShared?.();
}
