import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import { createSpring, getMotionSlowFactor } from "../spring.ts";
import type { Spring } from "../spring.ts";

// The switch of the prototype. The knob travels on a spring, stretches with its speed, grows into a pill while it is
// pressed, lands at the size of the new state, then wobbles once and settles.
const travel = { stiffness: 300, damping: 24 };
const size = { stiffness: 320, damping: 16 };
const pressSpring = { stiffness: 700, damping: 32 };
const wobble = { stiffness: 520, damping: 9 };
// The wobble starts this many milliseconds after the change, with this speed.
const wobbleDelay = 170;
const wobbleKick = -5;

// The knob of Nuxt UI's `USwitch` and of ui-sdk's switch. A plain switch uses its first child.
const knobSelector = "[data-slot=thumb], [data-slot=switch-thumb]";

/** Where the knob sits at rest in one state, from the left edge of the track, as drawn (its own `scale` included). */
interface Rest {
  center: number;
  width: number;
  height: number;
}

interface Knob {
  knob: HTMLElement;
  /** The rest of the off and the on state, measured when the switch was in that state. */
  rest: [Rest | undefined, Rest | undefined];
  /** The state that the stylesheet draws now, its `translate`, and the size of the knob without any transform. */
  now: { on: boolean; translate: [string, string]; width: number; height: number };
  position: Spring;
  velocity: number;
  size: Spring;
  press: Spring;
  wobble: Spring;
  wobbleTimer: ReturnType<typeof setTimeout> | undefined;
}

const knobs = new WeakMap<HTMLElement, Knob>();

function findKnob(element: HTMLElement): HTMLElement | undefined {
  const knob = element.querySelector<HTMLElement>(knobSelector) ?? element.firstElementChild;
  return knob instanceof HTMLElement ? knob : undefined;
}

function isOn(value: string | null): boolean {
  return value === "true";
}

/** Reads where the stylesheet puts the knob in the current state, without what the effect wrote. */
function measure(element: HTMLElement, knob: HTMLElement): { rest: Rest; translate: [string, string]; width: number; height: number } {
  writeMotionStyle(knob, { translate: null, scale: null });
  const track = element.getBoundingClientRect();
  const box = knob.getBoundingClientRect();
  const [x = "0px", y = "0px"] = getComputedStyle(knob).translate.split(" ");
  // The page may draw the switch scaled, such as in a zoomed preview. The effect works in the switch's own pixels.
  const zoom = element.offsetWidth ? track.width / element.offsetWidth : 1;
  return {
    rest: { center: (box.left + box.width / 2 - track.left) / zoom, width: box.width / zoom, height: box.height / zoom },
    translate: x === "none" ? ["0px", "0px"] : [x, y],
    width: knob.offsetWidth,
    height: knob.offsetHeight,
  };
}

// A state that was never measured mirrors the other one across the track, with the same size.
function restOf(state: Knob, on: boolean, trackWidth: number): Rest {
  const own = state.rest[on ? 1 : 0];
  if (own) return own;
  const other = state.rest[on ? 0 : 1]!;
  return { ...other, center: trackWidth - other.center };
}

function draw(element: HTMLElement, state: Knob): void {
  const { knob, now } = state;
  if (!state.position.active && !state.size.active && !state.press.active && !state.press.target && !state.wobble.active && state.wobbleTimer === undefined) {
    writeMotionStyle(knob, { translate: null, scale: null });
    return;
  }
  const trackWidth = element.offsetWidth;
  const off = restOf(state, false, trackWidth);
  const on = restOf(state, true, trackWidth);
  const p = state.position.value;
  const grown = state.size.value;
  // Shape follows speed: the knob stretches along its travel and thins across it, and grows while it is pressed.
  const stretch = Math.min(0.55, Math.abs(state.velocity) * 0.09) + state.press.value * 0.4;
  const sx = 1 + stretch + state.wobble.value * 0.14;
  const sy = 1 - stretch * 0.25 - state.wobble.value * 0.14;
  const width = (off.width + (on.width - off.width) * grown) * sx;
  const height = (off.height + (on.height - off.height) * grown) * sy;
  // The stretched knob stays inside the room that the knob takes at rest in either state.
  const start = Math.min(off.center - off.width / 2, on.center - on.width / 2);
  const end = Math.max(off.center + off.width / 2, on.center + on.width / 2);
  const center = off.center + (on.center - off.center) * p;
  const half = width / 2;
  const clamped = start + half > end - half ? (start + end) / 2 : Math.max(start + half, Math.min(end - half, center));
  const rest = now.on ? on : off;
  const shift = clamped - rest.center;
  writeMotionStyle(knob, {
    translate: `calc(${now.translate[0]} + ${shift.toFixed(2)}px) ${now.translate[1]}`,
    scale: `${(width / now.width).toFixed(4)} ${(height / now.height).toFixed(4)}`,
  });
}

/**
 * True when the knob still moves with a CSS transition of its own, as Nuxt UI's thumb does without the ViteHub theme.
 * The transition would smear each frame of the springs, so that knob keeps its own motion.
 */
function transitionsKnob(knob: HTMLElement): boolean {
  const style = getComputedStyle(knob);
  const durations = style.transitionDuration.split(",");
  return style.transitionProperty.split(",").some((property, index) =>
    /^\s*(?:transform|translate|scale|all)\s*$/.test(property) && Number.parseFloat(durations[index % durations.length]!) > 0);
}

function knobOf(element: HTMLElement, wasOn: boolean): Knob | undefined {
  const existing = knobs.get(element);
  if (existing && existing.knob.isConnected && element.contains(existing.knob)) return existing;
  const knob = findKnob(element);
  if (!knob || transitionsKnob(knob)) return;
  const value = wasOn ? 1 : 0;
  const redraw = () => draw(element, state);
  const state: Knob = {
    knob,
    rest: [undefined, undefined],
    now: { on: wasOn, translate: ["0px", "0px"], width: 1, height: 1 },
    position: createSpring(value, (position, velocity) => {
      state.velocity = velocity;
      redraw();
    }, travel),
    velocity: 0,
    size: createSpring(value, redraw, size),
    press: createSpring(0, redraw, pressSpring),
    wobble: createSpring(0, redraw, wobble),
    wobbleTimer: undefined,
  };
  knobs.set(element, state);
  return state;
}

/** Measures the state that the stylesheet draws now and keeps it as the rest of that state. */
function remeasure(element: HTMLElement, state: Knob, on: boolean): void {
  const { rest, translate, width, height } = measure(element, state.knob);
  state.rest[on ? 1 : 0] = rest;
  state.now = { on, translate, width, height };
}

function disabled(element: HTMLElement): boolean {
  return element.matches(":disabled, [aria-disabled=\"true\"]");
}

export const switchKnob: MotionEffect = {
  name: "switch",
  selector: "[role=switch]",
  press(element) {
    if (disabled(element)) return;
    const on = isOn(element.getAttribute("aria-checked"));
    const state = knobOf(element, on);
    if (!state) return;
    if (!state.position.active) remeasure(element, state, on);
    state.press.to(1);
    return { release: () => state.press.to(0) };
  },
  state(element, { attribute, oldValue, value }) {
    if (attribute !== "aria-checked") return;
    const on = isOn(value);
    const state = knobOf(element, isOn(oldValue));
    if (!state) return;
    remeasure(element, state, on);
    state.position.to(on ? 1 : 0);
    state.size.to(on ? 1 : 0);
    clearTimeout(state.wobbleTimer);
    state.wobbleTimer = undefined;
    if (!prefersReducedMotion()) {
      state.wobbleTimer = setTimeout(() => {
        state.wobbleTimer = undefined;
        state.wobble.to(0, { velocity: wobbleKick });
      }, wobbleDelay * getMotionSlowFactor());
    }
    draw(element, state);
  },
};
