/** The attributes whose change the motion layer reports to the `state` hook of an effect. */
export const motionStateAttributes = [
  "aria-checked",
  "aria-selected",
  "aria-pressed",
  "aria-expanded",
  "aria-valuenow",
  "aria-valuetext",
  "data-state",
  "data-checked",
  "data-open",
] as const;

export type MotionStateAttribute = (typeof motionStateAttributes)[number];

export interface MotionStateChange {
  attribute: MotionStateAttribute;
  oldValue: string | null;
  value: string | null;
}

/** What a press does next. The motion layer calls it until the pointer or the key goes up. */
export interface MotionPress {
  /**
   * The pointer moved while it was down, such as on a resize handle. Not called for a key press. A press with `move`
   * is a drag: it goes on when the pointer leaves the element, until the pointer goes up.
   */
  move?(event: PointerEvent): void;
  /** The pointer or the key went up, or the pointer left the element or was cancelled. */
  release(): void;
}

/**
 * One effect of the motion layer, for one interaction. The layer finds the element of the interaction by `selector`,
 * walks the composed path so it also finds elements in shadow DOM, and skips everything inside `[data-motion="none"]`.
 *
 * An effect writes only the separate CSS properties `scale`, `translate`, and `rotate`, and `filter` or `opacity` where
 * it needs them, through `writeMotionStyle`, so it adds to a component's own `transform`. It clears what it wrote when
 * its spring settles.
 */
export interface MotionEffect {
  /** A unique name, such as "press". Defining an effect with a name that exists replaces it. */
  name: string;
  /** The elements of the interaction, such as `[role=tab]`. The innermost element on the event path wins. */
  selector: string;
  /**
   * A pointer went down on the element (main button only), or Space or Enter went down while it had focus. Return a
   * `MotionPress` to hear the rest of the press. Not called under reduced motion.
   */
  press?(element: HTMLElement, event: PointerEvent | KeyboardEvent): MotionPress | void;
  /** One of `motionStateAttributes` changed on the element. Also called under reduced motion: keep the meaning. */
  state?(element: HTMLElement, change: MotionStateChange): void;
  /** The element was added to the page, such as a tooltip. Also called under reduced motion: keep the meaning. */
  enter?(element: HTMLElement): void;
}

const effects = new Map<string, MotionEffect>();
const changeListeners = new Set<() => void>();

/**
 * Adds an effect to the motion layer. Every installed layer runs it from the next interaction on. Returns a function
 * that removes it.
 */
export function defineMotionEffect(effect: MotionEffect): () => void {
  effects.set(effect.name, effect);
  for (const listener of changeListeners) listener();
  return () => {
    if (effects.get(effect.name) !== effect) return;
    effects.delete(effect.name);
    for (const listener of changeListeners) listener();
  };
}

/** The effects of the motion layer, in the order they were defined. */
export function listMotionEffects(): MotionEffect[] {
  return [...effects.values()];
}

export function onMotionEffectsChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/**
 * The CSS properties that the motion layer may write. `clip-path` hides the part of a tooltip that is still behind its
 * trigger.
 */
export type MotionStyleProperty = "scale" | "translate" | "rotate" | "filter" | "opacity" | "clip-path";

/** Writes motion properties inline. An empty string or `null` removes the property, so the stylesheet applies again. */
export function writeMotionStyle(element: HTMLElement | SVGElement, values: Partial<Record<MotionStyleProperty, string | null>>): void {
  for (const [property, value] of Object.entries(values)) {
    if (value) element.style.setProperty(property, value);
    else element.style.removeProperty(property);
  }
}
