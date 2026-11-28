import type { InjectionKey, Ref } from "vue";
import { inject } from "vue";

export interface MessageListContext {
  atBottom: Ref<boolean>;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export const messageListKey: InjectionKey<MessageListContext> = Symbol("message-list");

export function useMessageList(): MessageListContext {
  const context = inject(messageListKey);
  if (!context) throw new Error("useMessageList() must be called inside <MessageList>.");
  return context;
}
