import { computed } from "vue";
import type { CommentsState } from "../headless/comments.ts";
import type { CommentUpload } from "../components/comment-panel.ts";

export function useCommentAttachments(state: CommentsState, props: { upload?: CommentUpload; queueFiles: boolean }) {
  const mode = computed(() => {
    if (state.client.transport.supportsAttachments === false) return undefined;
    if (props.upload) return "upload";
    if (state.outbox.enabled && props.queueFiles) return "queue";
  });

  return {
    enabled: computed(() => mode.value !== undefined),
    queued(files: File[]): File[] | undefined {
      if (!state.outbox.enabled || (mode.value === "upload" && files.length > 0)) return undefined;
      return mode.value === "queue" ? files : [];
    },
    async prepare(files: File[]) {
      return {
        files: mode.value === "queue" ? files : [],
        attachments: mode.value === "upload" && files.length > 0 && props.upload ? await props.upload(files) : [],
      };
    },
  };
}
