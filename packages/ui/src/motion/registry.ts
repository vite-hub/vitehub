import { prefersReducedMotion } from "./reduced-motion.ts";

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
  // A native `<details>` opens and closes with its `open` attribute.
  "open",
  "data-leaving",
] as const;

export type MotionStateAttribute = (typeof motionStateAttributes)[number];
export type MotionRoot = Document | ShadowRoot | Element;

export interface MotionStateChange {
  attribute: MotionStateAttribute;
  oldValue: string | null;
  value: string | null;
}

/** The children or the text of an element changed, such as Vue writing the new label of a button. */
export interface MotionContentChange {
  /** The nodes that the change added, in order. */
  added: Node[];
  /** The nodes that the change removed, in order. */
  removed: Node[];
  /** The text before the change, when the change replaced all of it. */
  oldText: string | undefined;
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
  /** Starts tracking state in an installed root and returns its cleanup. */
  watch?(root: MotionRoot): () => void;
  /**
   * A pointer went down on the element (main button only), or Space or Enter went down while it had focus. Return a
   * `MotionPress` to hear the rest of the press. Not called under reduced motion.
   */
  press?(element: HTMLElement, event: PointerEvent | KeyboardEvent): MotionPress | void;
  /** One of `motionStateAttributes` changed on the element. Also called under reduced motion: keep the meaning. */
  state?(element: HTMLElement, change: MotionStateChange): void;
  /** The element was added to the page, such as a tooltip. Also called under reduced motion: keep the meaning. */
  enter?(element: HTMLElement): void;
  /**
   * The children or the text of the element changed, such as the label or the icon of a button. Also called under
   * reduced motion, and for the changes that effects make themselves: tell them apart by `added`.
   */
  content?(element: HTMLElement | SVGElement, change: MotionContentChange): void;
}

interface EffectRegistration {
  effect: MotionEffect;
  isReduced: () => boolean;
  removeFromShared?: () => void;
}

const effects = new Map<string, EffectRegistration>();
const changeListeners = new Set<() => void>();

/**
 * A page can load more than one copy of this module, such as the app's, the one in the bundle of the page pill, and the
 * one that Comark UI inlines in a document. The first copy that installs is the shared layer: the copies that install
 * after it give it their effects and their installs, so one set of listeners and one observer serve every copy, and
 * an element that two copies cover moves once.
 */
export interface SharedMotionLayer {
  define(effect: MotionEffect, isReduced: () => boolean): () => void;
  install(root: Document | ShadowRoot | Element, effects: readonly MotionEffect[], isReduced: () => boolean): () => void;
}

const sharedKey = Symbol.for("vite-hub.motion.layer");
let ownLayer: SharedMotionLayer | undefined;

/** The shared layer of another copy of this module, when that copy installed first. */
export function otherMotionLayer(): SharedMotionLayer | undefined {
  const shared: unknown = Reflect.get(globalThis, sharedKey);
  if (!shared || shared === ownLayer || typeof shared !== "object" || !("define" in shared) || !("install" in shared)) return undefined;
  // SAFETY: only copies of this module write the key, with an object of this shape.
  return shared as SharedMotionLayer;
}

/** Makes this copy the shared layer when no copy is yet. */
export function claimMotionLayer(layer: SharedMotionLayer): void {
  ownLayer = layer;
  if (!Reflect.get(globalThis, sharedKey)) Reflect.set(globalThis, sharedKey, layer);
}

export function handOffMotionEffects(shared: SharedMotionLayer): void {
  const registrations = [...effects.values()];
  effects.clear();
  for (const registration of registrations) registration.removeFromShared = shared.define(registration.effect, registration.isReduced);
}

/**
 * Adds an effect to the motion layer. Every installed layer runs it from the next interaction on. Returns a function
 * that removes it. When another copy of the module is the shared layer, the effect goes to that copy.
 */
export function defineMotionEffect(effect: MotionEffect): () => void {
  const shared = otherMotionLayer();
  if (!shared) return defineOwnEffect(effect);
  handOffMotionEffects(shared);
  return shared.define(effect, prefersReducedMotion);
}

export function defineOwnEffect(effect: MotionEffect, isReduced = prefersReducedMotion): () => void {
  const registration: EffectRegistration = { effect, isReduced };
  effects.set(effect.name, registration);
  for (const listener of changeListeners) listener();
  return () => {
    if (registration.removeFromShared) return registration.removeFromShared();
    if (effects.get(effect.name) !== registration) return;
    effects.delete(effect.name);
    for (const listener of changeListeners) listener();
  };
}

/** The effects of the motion layer, in the order they were defined. */
export function listMotionEffects(): MotionEffect[] {
  return [...effects.values()].map(registration => registration.effect);
}

export function motionEffectRegistrations(): EffectRegistration[] {
  return [...effects.values()];
}

export function onMotionEffectsChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/**
 * The CSS properties that the motion layer may write. `clip-path` hides the part of a tooltip that is still behind its
 * trigger. `width` is only for a panel that opens beside the page, as a sidebar does.
 */
export type MotionStyleProperty = "scale" | "translate" | "rotate" | "filter" | "opacity" | "clip-path" | "width";

/** Writes motion properties inline. An empty string or `null` removes the property, so the stylesheet applies again. */
export function writeMotionStyle(element: HTMLElement | SVGElement, values: Partial<Record<MotionStyleProperty, string | null>>): void {
  for (const [property, value] of Object.entries(values)) {
    if (value) element.style.setProperty(property, value);
    else element.style.removeProperty(property);
  }
}
