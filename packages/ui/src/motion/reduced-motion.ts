type ReducedMotionListener = (reduced: boolean) => void;

const listeners = new Set<ReducedMotionListener>();
let query: MediaQueryList | undefined;
let forced: boolean | undefined;
let current = false;

function read(): boolean {
  return forced ?? query?.matches ?? false;
}

function update(): void {
  const next = read();
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

// The query starts on the first read, so the module loads on the server and in tests without `matchMedia`.
function watch(): void {
  if (query || typeof matchMedia !== "function") return;
  query = matchMedia("(prefers-reduced-motion: reduce)");
  // Some test doubles of `matchMedia` have no listeners. Then the setting is read once.
  query.addEventListener?.("change", update);
  current = read();
}

/**
 * True when the person asked for less motion. It follows the system setting live. Under it, nothing travels,
 * stretches, or wobbles: springs jump to their target, and helpers use a 150ms crossfade.
 */
export function prefersReducedMotion(): boolean {
  watch();
  return read();
}

/** Calls `listener` each time reduced motion turns on or off. Returns a function that stops it. */
export function onReducedMotionChange(listener: ReducedMotionListener): () => void {
  watch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sets reduced motion on or off whatever the system setting is, such as from an app setting or a test page. `undefined`
 * follows the system setting again.
 */
export function forceReducedMotion(reduced: boolean | undefined): void {
  watch();
  forced = reduced;
  update();
}
