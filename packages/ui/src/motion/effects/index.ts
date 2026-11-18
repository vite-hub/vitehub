import type { MotionEffect } from "../registry.ts";
import { divider } from "./divider.ts";
import { press } from "./press.ts";
import { slider } from "./slider.ts";

/** The effects that `installMotion` defines. Add a role effect here, in a file of its own. */
export const builtInEffects: MotionEffect[] = [
  press,
  slider,
  divider,
];
