import type { MotionEffect } from "../registry.ts";
import { check } from "./check.ts";
import { disclosure } from "./disclosure.ts";
import { divider } from "./divider.ts";
import { jelly } from "./jelly.ts";
import { buttonIcon, label } from "./label.ts";
import { leave } from "./leave.ts";
import { panel } from "./panel.ts";
import { press } from "./press.ts";
import { select } from "./select.ts";
import { slider } from "./slider.ts";
import { switchKnob } from "./switch.ts";
import { toast } from "./toast.ts";
import { appear, tooltip } from "./tooltip.ts";

/**
 * Every built-in effect: what `installMotion()` of `@vite-hub/ui/motion` runs. Add a role effect here, in a file of its
 * own, and export it from `src/motion-core.ts`.
 */
export const motionEffects: readonly MotionEffect[] = [
  press,
  select,
  switchKnob,
  check,
  jelly,
  tooltip,
  appear,
  toast,
  slider,
  divider,
  label,
  buttonIcon,
  disclosure,
  leave,
  panel,
];
