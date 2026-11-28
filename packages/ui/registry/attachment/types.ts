export type AttachmentStatus = "idle" | "uploading" | "processing" | "error" | "done";
export type AttachmentSize = "xs" | "sm" | "md";
export type AttachmentOrientation = "horizontal" | "vertical";
export type AttachmentMediaKind = "icon" | "image";

export interface AttachmentProps {
  /** Where the file is: `idle` before an upload, `uploading`, `processing`, `done`, or `error`. */
  status?: AttachmentStatus;
  size?: AttachmentSize;
  /** `vertical` puts the media above the name, as a tile. */
  orientation?: AttachmentOrientation;
}

export interface AttachmentSlots {
  /** `AttachmentMedia`, `AttachmentContent`, `AttachmentActions`, and an optional `AttachmentTrigger`. */
  default?: () => unknown;
}

export interface AttachmentMediaProps {
  /** `image` shows a picture that fills the square, `icon` an icon in the middle of it. */
  kind?: AttachmentMediaKind;
}

export interface AttachmentMediaSlots {
  default?: () => unknown;
}

export interface AttachmentActionProps {
  /** The accessible name of the button. */
  label?: string;
  disabled?: boolean;
}

export interface AttachmentActionSlots {
  /** The icon. Default: an X. */
  default?: () => unknown;
}

export interface AttachmentTriggerSlots {
  default?: () => unknown;
  /**
   * Renders the trigger as another element, such as a link to the file. Bind `props` to it, which holds the
   * `data-slot`, and render `children` inside it.
   */
  render?: (scope: { props: Record<string, unknown>; children: () => unknown }) => unknown;
}
