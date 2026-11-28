export type BubbleAlign = "start" | "end";
export type BubbleVariant = "solid" | "soft" | "outline" | "ghost" | "destructive";
export type BubbleTone = "neutral" | "success" | "warning" | "error" | "info";

export interface BubbleProps {
  /** The side the bubble sits on. Inside a `Message` with `align="end"`, it is `end` too. */
  align?: BubbleAlign;
  /** `solid` is the primary color, `soft` a light fill, `outline` a border, `ghost` no frame, and `destructive` an error. */
  variant?: BubbleVariant;
  /** The color of a `soft` bubble. `neutral` is the gray fill. */
  tone?: BubbleTone;
}

export interface BubbleSlots {
  /** `BubbleContent`, and `BubbleReactions` when the bubble has reactions. */
  default?: () => unknown;
}

export interface BubbleContentSlots {
  default?: () => unknown;
  /**
   * Renders the content as another element, such as a link or a button. Bind `props` to it, which holds the
   * `data-slot`, and render `children` inside it.
   */
  render?: (scope: { props: Record<string, unknown>; children: () => unknown }) => unknown;
}

export interface BubbleReactionsProps {
  /** The edge of the bubble that the reactions sit at. */
  align?: BubbleAlign;
  /** Above or below the bubble. */
  side?: "top" | "bottom";
}

export interface BubbleReactionsSlots {
  default?: () => unknown;
}
