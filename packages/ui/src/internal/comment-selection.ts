import type { CommentThread } from "@vite-hub/comments/client";
import { computed, type Ref } from "vue";

export function commentThreadKey(thread: CommentThread): string {
  return thread.requestId === undefined
    ? thread.id
    : JSON.stringify([thread.subject.kind, thread.subject.id, thread.author.id, thread.requestId]);
}

export function useSelectedComment(threads: Ref<readonly CommentThread[]>, id: Ref<string | null>) {
  const selection = computed<{ id: string | null; thread: CommentThread | undefined }>(previous => {
    const selectedId = id.value;
    const items = threads.value;
    const direct = items.find(thread => thread.id === selectedId);
    const last = previous?.id === selectedId ? previous.thread : undefined;
    const key = last?.requestId === undefined ? undefined : commentThreadKey(last);
    return { id: selectedId, thread: direct ?? (key === undefined ? undefined : items.find(thread => commentThreadKey(thread) === key)) };
  });
  return computed(() => selection.value.thread);
}
