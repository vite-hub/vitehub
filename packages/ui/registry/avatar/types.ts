export type AvatarSize = "xs" | "sm" | "md" | "lg";

export interface AvatarProps {
  size?: AvatarSize;
  src?: string;
  alt?: string;
  fallback?: string;
}

export interface AvatarSlots {
  default?: () => unknown;
}

export interface AvatarImageProps {
  src: string;
  alt?: string;
}

export interface AvatarFallbackSlots {
  default?: () => unknown;
}
