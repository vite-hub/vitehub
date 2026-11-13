import { css, definePrimitive, type PrimitiveOptions, type SlotDefinition } from "@ui-sdk/core";

// Aspect Ratio keeps its width and height in a ratio, with CSS `aspect-ratio`,
// so a video or an image holds its place before it loads.

/** The options `aspectRatioPrimitive` takes. A component takes them as props on its root. */
export type AspectRatioOptions = {
  /**
   * The width divided by the height, like `16 / 9`.
   * @defaultValue 1
   */
  ratio?: number;
} & PrimitiveOptions;

/** The state the `root` slot of `aspectRatioPrimitive` hands `render` functions and state-based class names. */
export type AspectRatioState = {
  /** The width divided by the height. */
  ratio: number;
};

type AspectRatioSlots = {
  root: SlotDefinition<AspectRatioState, {}, { id?: string }, AspectRatioState>;
};

/** The type of `aspectRatioPrimitive`. */
export interface AspectRatioPrimitive
  extends ReturnType<typeof definePrimitive<AspectRatioOptions, AspectRatioState, {}, AspectRatioSlots>> {}

const fromOptions = (options: AspectRatioOptions): AspectRatioState => ({ ratio: options.ratio ?? 1 });

/**
 * The aspect ratio primitive, with the slot `root`. It sets `aspect-ratio` and
 * the `--aspect-ratio` variable on the element. Render it with an adapter's `createParts`.
 */
export const aspectRatioPrimitive: AspectRatioPrimitive = definePrimitive({
  name: "aspect-ratio",
  options: { ratio: "number" },
  state: fromOptions,
  sync: fromOptions,
  api: () => ({}),
  slots: (slot) => ({
    root: slot<{}, AspectRatioState>({
      state: (state) => ({ ratio: state.ratio }),
      attrs: (state) => ({ style: css({ "aspect-ratio": state.ratio, "--aspect-ratio": state.ratio }) }),
    }),
  }),
});
