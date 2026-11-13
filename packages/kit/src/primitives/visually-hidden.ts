import { css, definePrimitive, type PrimitiveOptions, type SlotDefinition } from "@ui-sdk/core";

// Visually Hidden keeps content for screen readers and out of sight, like the
// name of a button that shows only an icon.

/**
 * What it hides from: only sight, so it can still take focus, or also
 * assistive technology, like an input that only a form reads.
 */
export type VisuallyHiddenFeature = "focusable" | "fully-hidden";

/** The options `visuallyHiddenPrimitive` takes. A component takes them as props on its root. */
export type VisuallyHiddenOptions = {
  /**
   * What it hides from.
   * @defaultValue "focusable"
   */
  feature?: VisuallyHiddenFeature;
} & PrimitiveOptions;

/** The state the `root` slot of `visuallyHiddenPrimitive` hands `render` functions and state-based class names. */
export type VisuallyHiddenState = {
  feature: VisuallyHiddenFeature;
};

type VisuallyHiddenSlots = {
  root: SlotDefinition<VisuallyHiddenState, {}, { id?: string }, VisuallyHiddenState>;
};

/** The type of `visuallyHiddenPrimitive`. */
export interface VisuallyHiddenPrimitive
  extends ReturnType<typeof definePrimitive<VisuallyHiddenOptions, VisuallyHiddenState, {}, VisuallyHiddenSlots>> {}

const fromOptions = (options: VisuallyHiddenOptions): VisuallyHiddenState => ({
  feature: options.feature ?? "focusable",
});

// One pixel, clipped, out of the flow: screen readers still read it.
const hidden = css({
  position: "absolute",
  border: 0,
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  "clip-path": "inset(50%)",
  "white-space": "nowrap",
  "word-wrap": "normal",
});

/**
 * The visually hidden primitive, with the slot `root`. Render it with an
 * adapter's `createParts`.
 */
export const visuallyHiddenPrimitive: VisuallyHiddenPrimitive = definePrimitive({
  name: "visually-hidden",
  options: { feature: "string" },
  state: fromOptions,
  sync: fromOptions,
  api: () => ({}),
  slots: (slot) => ({
    root: slot<{}, VisuallyHiddenState>({
      state: (state) => ({ feature: state.feature }),
      attrs: (state) => {
        const fully = state.feature === "fully-hidden";
        return {
          style: hidden,
          "aria-hidden": fully ? "true" : undefined,
          tabindex: fully ? "-1" : undefined,
          "data-hidden": fully ? "" : undefined,
        };
      },
    }),
  }),
});
