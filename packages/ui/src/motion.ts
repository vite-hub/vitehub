// The motion layer of docs/design/motion.md, with no Vue, so plain TypeScript surfaces such as the page pill use it too.
export { installMotion, isMotionOff } from "./motion/layer.ts";
export { defineMotionEffect, listMotionEffects, motionStateAttributes, writeMotionStyle } from "./motion/registry.ts";
export type { MotionEffect, MotionPress, MotionStateAttribute, MotionStateChange, MotionStyleProperty } from "./motion/registry.ts";
export { forceReducedMotion, onReducedMotionChange, prefersReducedMotion } from "./motion/reduced-motion.ts";
export { createSpring, getMotionSlowFactor, setMotionSlowFactor, springs } from "./motion/spring.ts";
export type { Spring, SpringFrame, SpringPreset, SpringTarget } from "./motion/spring.ts";
export type { MotionContentChange } from "./motion/registry.ts";
export { morphText } from "./motion/helpers/text.ts";
export { swapIcon } from "./motion/helpers/icon.ts";
export type { IconEnter, IconExit, SwapIconOptions } from "./motion/helpers/icon.ts";
export { rollNumber } from "./motion/helpers/number.ts";
export { ring } from "./motion/helpers/ring.ts";
