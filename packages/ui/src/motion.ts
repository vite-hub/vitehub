// The motion layer of docs/design/motion.md, with no Vue, so plain TypeScript surfaces such as the page pill use it too.
export { installMotion, isMotionOff } from "./motion/layer.ts";
export { defineMotionEffect, listMotionEffects, motionStateAttributes, writeMotionStyle } from "./motion/registry.ts";
export type { MotionEffect, MotionPress, MotionStateAttribute, MotionStateChange, MotionStyleProperty } from "./motion/registry.ts";
export { forceReducedMotion, onReducedMotionChange, prefersReducedMotion } from "./motion/reduced-motion.ts";
export { createSpring, getMotionSlowFactor, setMotionSlowFactor, springs } from "./motion/spring.ts";
export type { Spring, SpringFrame, SpringPreset, SpringTarget } from "./motion/spring.ts";
export { createMotionList } from "./motion/list.ts";
export type { MotionList, MotionListOptions, MotionListOrigin, MotionListPlay } from "./motion/list.ts";
export { createProgress } from "./motion/progress.ts";
export type { Progress, ProgressOptions, ProgressPhase } from "./motion/progress.ts";
export { createDropField } from "./motion/drop-field.ts";
export type { DropField, DropFieldOptions } from "./motion/drop-field.ts";
export { createHoldToDelete } from "./motion/hold-to-delete.ts";
export type { HoldToDelete, HoldToDeleteOptions, HoldToDeleteState } from "./motion/hold-to-delete.ts";
