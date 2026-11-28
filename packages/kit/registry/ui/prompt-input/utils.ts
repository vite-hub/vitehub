import type { ComputedRef, InjectionKey, Ref } from "vue";
import { inject } from "vue";

export interface PromptInputMessage {
  text: string;
  files: File[];
}

export interface PromptInputContext {
  text: Ref<string>;
  files: Ref<File[]>;
  pending: ComputedRef<boolean>;
  canSubmit: ComputedRef<boolean>;
  submit: () => void;
  stop: () => void;
  textarea: () => HTMLTextAreaElement | null;
}

export const promptInputKey: InjectionKey<PromptInputContext> = Symbol("prompt-input");

export function usePromptInput(): PromptInputContext {
  const context = inject(promptInputKey);
  if (!context) throw new Error("usePromptInput() must be called inside <PromptInput>.");
  return context;
}
