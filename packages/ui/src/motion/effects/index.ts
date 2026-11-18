import type { MotionEffect } from "../registry.ts";
import { buttonIcon, label } from "./label.ts";
import { press } from "./press.ts";

/** The effects that `installMotion` defines. Add a role effect here, in a file of its own. */
export const builtInEffects: MotionEffect[] = [
  press,
  label,
  buttonIcon,
];
