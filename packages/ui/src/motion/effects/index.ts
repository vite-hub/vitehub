import type { MotionEffect } from "../registry.ts";
import { press } from "./press.ts";
import { toast } from "./toast.ts";
import { tooltip } from "./tooltip.ts";

/** The effects that `installMotion` defines. Add a role effect here, in a file of its own. */
export const builtInEffects: MotionEffect[] = [press, tooltip, toast];
