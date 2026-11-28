import type { ChatStatus, FileUIPart } from "ai";

export interface PromptInputProps {
  /** The text, with `v-model`. */
  modelValue?: string;
  /** The first text when `v-model` is not bound. */
  defaultValue?: string;
  /** The attached files, with `v-model:files`. */
  files?: readonly FileUIPart[];
  /** The first files when `v-model:files` is not bound. */
  defaultFiles?: readonly FileUIPart[];
  /** The chat status. While a reply streams, the submit button stops it. After an error, it retries. */
  status?: ChatStatus;
  /** The file types that the file picker shows, as in `<input accept>`. */
  accept?: string;
  /** The prompt keeps one file: a new pick replaces it. */
  single?: boolean;
  /** Takes the picked or pasted files and returns the ones to attach. */
  filterFiles?: (files: readonly File[]) => readonly File[];
  /** The prompt takes no input: the field, the attach button, Send, and Retry are disabled. Stop stays pressable. */
  disabled?: boolean;
  /** The text is being sent: the field is read-only, Enter does nothing, and Send shows a spinner. */
  readonly?: boolean;
  placeholder?: string;
  /** The name of the submit button while the status is `ready`. Default "Send prompt". */
  submitLabel?: string;
}

export interface PromptInputSubmitEvent {
  text: string;
  files: readonly FileUIPart[];
}

export interface PromptInputEmits {
  "update:modelValue": [value: string];
  "update:files": [files: readonly FileUIPart[]];
  /** Enter or Send, with the trimmed text and the files. */
  submit: [event: PromptInputSubmitEvent];
  /** Stop, while a reply streams. */
  stop: [];
  /** Retry, after an error. */
  retry: [];
  /** A file could not be read. */
  error: [event: { error: unknown }];
}

export interface PromptInputSlotScope {
  canSubmit: boolean;
  /** Files are being read before they show. */
  preparing: boolean;
  status: ChatStatus;
}

export interface PromptInputSlots {
  /**
   * Replaces the default composition: `PromptInputAttachments`, `PromptInputTextarea`, and a `PromptInputToolbar` with
   * `PromptInputAttach` and `PromptInputSubmit`. Leave out `PromptInputAttach` to turn off files.
   */
  default?: (scope: PromptInputSlotScope) => unknown;
}

export interface PromptInputAttachmentsProps {
  /** The remove buttons are disabled, for example while the files are sent. */
  disabled?: boolean;
}

export interface PromptInputAttachProps {
  /** `outline` is a ring, `ghost` a muted icon for a box that has its own frame. */
  variant?: "outline" | "ghost";
  /** Files cannot be added. Text stays editable. */
  disabled?: boolean;
  /** The accessible name of the button and the file input. */
  label?: string;
}

export interface PromptInputAttachSlots {
  /** The icon. Default: a plus. */
  default?: () => unknown;
}

export interface PromptInputSubmitSlots {
  /** The icon or the label. Default: an arrow up to send, a square to stop, and a circle arrow to retry. */
  default?: (scope: PromptInputSlotScope) => unknown;
}

export interface PromptInputToolbarSlots {
  default?: () => unknown;
}
