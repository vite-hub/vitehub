// The motion layer of docs/design/motion.md, with no Vue, so plain TypeScript surfaces such as the page pill use it too.
export { installMotion, isMotionOff } from "./motion/layer.ts";
export { defineMotionEffect, listMotionEffects, motionStateAttributes, writeMotionStyle } from "./motion/registry.ts";
export type { MotionEffect, MotionPress, MotionStateAttribute, MotionStateChange, MotionStyleProperty } from "./motion/registry.ts";
export { forceReducedMotion, onReducedMotionChange, prefersReducedMotion } from "./motion/reduced-motion.ts";
export { createSpring, getMotionSlowFactor, setMotionSlowFactor, springs } from "./motion/spring.ts";
export type { Spring, SpringFrame, SpringPreset, SpringTarget } from "./motion/spring.ts";
export type { MotionContentChange } from "./motion/registry.ts";
// The helpers for what only a component knows: a label, an icon, or a count that changes, a finished action, a list
// that changes, work that runs, a file drop, and a delete that can be undone.
export { morphText } from "./motion/helpers/text.ts";
export { swapIcon } from "./motion/helpers/icon.ts";
export type { IconEnter, IconExit, SwapIconOptions } from "./motion/helpers/icon.ts";
export { rollNumber } from "./motion/helpers/number.ts";
export { ring } from "./motion/helpers/ring.ts";
export { createMotionList } from "./motion/list.ts";
export type { MotionList, MotionListOptions, MotionListOrigin, MotionListPlay } from "./motion/list.ts";
export { createProgress } from "./motion/progress.ts";
export type { Progress, ProgressOptions, ProgressPhase } from "./motion/progress.ts";
export { createDropField } from "./motion/drop-field.ts";
export type { DropField, DropFieldOptions } from "./motion/drop-field.ts";
export { createHoldToDelete } from "./motion/hold-to-delete.ts";
export type { HoldToDelete, HoldToDeleteOptions, HoldToDeleteState } from "./motion/hold-to-delete.ts";
