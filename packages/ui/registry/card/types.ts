export type CardVariant = "outline" | "soft";

export interface CardProps {
  variant?: CardVariant;
}

export interface CardSlots {
  default?: () => unknown;
}

export interface CardHeaderSlots {
  default?: () => unknown;
}

export interface CardTitleSlots {
  default?: () => unknown;
}

export interface CardDescriptionSlots {
  default?: () => unknown;
}

export interface CardActionSlots {
  default?: () => unknown;
}

export interface CardContentSlots {
  default?: () => unknown;
}

export interface CardFooterSlots {
  default?: () => unknown;
}
