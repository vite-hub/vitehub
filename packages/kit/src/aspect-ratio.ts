import { createParts, type Parts } from "@ui-sdk/vue/primitive";

import { aspectRatioPrimitive, type AspectRatioPrimitive } from "./primitives/aspect-ratio.ts";

type AspectRatioTags = { root: "div" };

const parts: Parts<AspectRatioPrimitive, AspectRatioTags> = createParts(aspectRatioPrimitive, { root: "div" });

/**
 * Keeps its width and height in a `ratio`, like `16 / 9`, with CSS
 * `aspect-ratio`. Give the image or video inside it `width: 100%` and `height: 100%`.
 */
export const AspectRatio: Parts<AspectRatioPrimitive, AspectRatioTags>["Root"] = parts.Root;

export { aspectRatioPrimitive };
export type { AspectRatioOptions, AspectRatioPrimitive, AspectRatioState } from "./primitives/aspect-ratio.ts";
