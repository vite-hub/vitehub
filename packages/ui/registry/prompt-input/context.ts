import type { ChatStatus, FileUIPart } from "ai";
import { type ComputedRef, inject, type InjectionKey, type WritableComputedRef } from "vue";

/** What `PromptInput` shares with its parts. */
export interface PromptInputContext {
  text: WritableComputedRef<string>;
  files: ComputedRef<readonly FileUIPart[]>;
  status: ComputedRef<ChatStatus>;
  disabled: ComputedRef<boolean>;
  readonly: ComputedRef<boolean>;
  placeholder: ComputedRef<string | undefined>;
  accept: ComputedRef<string | undefined>;
  single: ComputedRef<boolean>;
  submitLabel: ComputedRef<string | undefined>;
  /** The accessible name of the field: the root's `aria-label`, else "Message". */
  label: ComputedRef<string>;
  canSubmit: ComputedRef<boolean>;
  /** Files are being read before they show. */
  preparing: ComputedRef<boolean>;
  /** A `PromptInputAttach` that is not disabled is in the prompt, so a paste can add files. */
  takesFiles: ComputedRef<boolean>;
  /** Registers a `PromptInputAttach`. The getter says whether it is disabled. Returns the function that removes it. */
  addAttach: (disabled: () => boolean) => () => void;
  addFiles: (files: FileList | Iterable<File>, onAccepted?: () => void) => Promise<void>;
  removeFile: (index: number) => void;
  /** Submits the form, as Enter does. */
  requestSubmit: () => void;
  /** The submit button: Send when ready, Stop while a reply streams, and Retry after an error. */
  press: () => void;
}

export const promptInputKey: InjectionKey<PromptInputContext> = Symbol("PromptInput");

/** The context of the `PromptInput` around a part. A part outside a `PromptInput` gets none and renders nothing. */
export function usePromptInput(): PromptInputContext | undefined {
  return inject(promptInputKey, undefined);
}
