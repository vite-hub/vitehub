// `@vite-hub/ui/motion/core`: the motion layer of docs/design/motion.md, where `installMotion` runs only the effects that
// it is given. A surface with its own bundle, such as the page pill, uses it so that the other effects stay out.
export { installMotion, isMotionOff } from "./motion/layer.ts";
export type { InstallMotionOptions, MotionRoot } from "./motion/layer.ts";
// The built-in effects, one per interaction of docs/design/motion.md, and the list of all of them.
export { motionEffects } from "./motion/effects/index.ts";
export { check as checkEffect } from "./motion/effects/check.ts";
export { disclosure as disclosureEffect } from "./motion/effects/disclosure.ts";
export { divider as dividerEffect } from "./motion/effects/divider.ts";
export { jelly as jellyEffect } from "./motion/effects/jelly.ts";
export { buttonIcon as buttonIconEffect, label as labelEffect } from "./motion/effects/label.ts";
export { leave as leaveEffect } from "./motion/effects/leave.ts";
export { panel as panelEffect } from "./motion/effects/panel.ts";
export { press as pressEffect } from "./motion/effects/press.ts";
export { select as selectEffect } from "./motion/effects/select.ts";
export { slider as sliderEffect } from "./motion/effects/slider.ts";
export { switchKnob as switchEffect } from "./motion/effects/switch.ts";
export { toast as toastEffect } from "./motion/effects/toast.ts";
export { appear as appearEffect, tooltip as tooltipEffect } from "./motion/effects/tooltip.ts";
export { defineMotionEffect, listMotionEffects, motionStateAttributes, writeMotionStyle } from "./motion/registry.ts";
export type { MotionEffect, MotionPress, MotionStateAttribute, MotionStateChange, MotionStyleProperty } from "./motion/registry.ts";
export { forceReducedMotion, onReducedMotionChange, prefersReducedMotion } from "./motion/reduced-motion.ts";
export { createSpring, getMotionSlowFactor, setMotionSlowFactor, springs } from "./motion/spring.ts";
export type { Spring, SpringFrame, SpringPreset, SpringTarget } from "./motion/spring.ts";
export type { MotionContentChange } from "./motion/registry.ts";
// The helpers for what only a component knows: a label, an icon, or a count that changes, a finished action, a list
// that changes, work that runs, a file drop, a delete that can be undone, a box that refuses an action, and a thing that
// moves to a new place.
export { morphText } from "./motion/helpers/text.ts";
export { swapIcon } from "./motion/helpers/icon.ts";
export type { IconEnter, IconExit, SwapIconOptions } from "./motion/helpers/icon.ts";
export { rollNumber } from "./motion/helpers/number.ts";
export { ring } from "./motion/helpers/ring.ts";
export { shake } from "./motion/helpers/shake.ts";
export { travel } from "./motion/helpers/travel.ts";
export type { Travel, TravelBox, TravelOptions } from "./motion/helpers/travel.ts";
export { createMotionList } from "./motion/list.ts";
export type { MotionList, MotionListOptions, MotionListOrigin, MotionListPlay } from "./motion/list.ts";
export { createProgress } from "./motion/progress.ts";
export type { Progress, ProgressOptions, ProgressPhase } from "./motion/progress.ts";
export { createDropField } from "./motion/drop-field.ts";
export type { DropField, DropFieldOptions } from "./motion/drop-field.ts";
export { createHoldToDelete } from "./motion/hold-to-delete.ts";
export type { HoldToDelete, HoldToDeleteOptions, HoldToDeleteState } from "./motion/hold-to-delete.ts";
