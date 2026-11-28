export type EmptySize = "xs" | "sm" | "md";
export type EmptyVariant = "ghost" | "outline";

export interface EmptyProps {
  size?: EmptySize;
  variant?: EmptyVariant;
}

export interface EmptySlots {
  default?: () => unknown;
}

export interface EmptyHeaderSlots {
  default?: () => unknown;
}

export interface EmptyMediaSlots {
  default?: () => unknown;
}

export interface EmptyTitleSlots {
  default?: () => unknown;
}

export interface EmptyDescriptionSlots {
  default?: () => unknown;
}

export interface EmptyContentSlots {
  default?: () => unknown;
}
