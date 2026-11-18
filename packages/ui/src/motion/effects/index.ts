import type { MotionEffect } from "../registry.ts";
import { check } from "./check.ts";
import { divider } from "./divider.ts";
import { jelly } from "./jelly.ts";
import { press } from "./press.ts";
import { select } from "./select.ts";
import { slider } from "./slider.ts";
import { switchKnob } from "./switch.ts";
import { toast } from "./toast.ts";
import { tooltip } from "./tooltip.ts";

/** The effects that `installMotion` defines. Add a role effect here, in a file of its own. */
export const builtInEffects: MotionEffect[] = [
  press,
  select,
  switchKnob,
  check,
  jelly,
  tooltip,
  toast,
  slider,
  divider,
];
