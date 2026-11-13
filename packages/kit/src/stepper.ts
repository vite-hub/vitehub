import { createParts, type Parts } from "@ui-sdk/vue/primitive";

import { stepperPrimitive, type StepperPrimitive } from "./primitives/stepper.ts";

type StepperTags = {
  root: "div";
  item: "div";
  trigger: "button";
  indicator: "div";
  title: "div";
  description: "div";
  separator: "div";
  next: "button";
  previous: "button";
};
type StepperParts = Parts<StepperPrimitive, StepperTags>;

const parts: StepperParts = createParts(stepperPrimitive, {
  root: "div",
  item: "div",
  trigger: "button",
  indicator: "div",
  title: "div",
  description: "div",
  separator: "div",
  next: "button",
  previous: "button",
});

/**
 * The steps of a process, like a checkout. `v-model` binds the current step,
 * a number. The triggers have one tab stop, and the arrow keys move between
 * them. With `linear`, the default, a person can only go back, or one step ahead.
 */
export const Stepper: StepperParts["Root"] = parts.Root;

/** One step. Pass its number as `value`. The current one has `data-current`. */
export const StepperItem: StepperParts["Item"] = parts.Item;

/** Goes to its step. The current step's trigger has `aria-current="step"`. Its step's title names it, and its description describes it. */
export const StepperTrigger: StepperParts["Trigger"] = parts.Trigger;

/** Shows where its step stands, like a number or a check mark. */
export const StepperIndicator: StepperParts["Indicator"] = parts.Indicator;

/** Names its step. */
export const StepperTitle: StepperParts["Title"] = parts.Title;

/** Tells more about its step. */
export const StepperDescription: StepperParts["Description"] = parts.Description;

/** The line between its step and the next one. Hidden from assistive technology. */
export const StepperSeparator: StepperParts["Separator"] = parts.Separator;

/** Goes to the next step. Disabled at the last one. */
export const StepperNext: StepperParts["Next"] = parts.Next;

/** Goes to the step before. Disabled at the first one. */
export const StepperPrevious: StepperParts["Previous"] = parts.Previous;

export { stepperPrimitive };
export type {
  StepperApi,
  StepperItemProps,
  StepperItemState,
  StepperOptions,
  StepperOrientation,
  StepperPrimitive,
  StepperState,
  StepperStatus,
  StepperValueChangeReason,
} from "./primitives/stepper.ts";
