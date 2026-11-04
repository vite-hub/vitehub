import { inject, type InjectionKey } from "vue";
import type { CommentsState } from "../headless/comments.ts";

export const commentsKey: InjectionKey<CommentsState> = Symbol("ViteHubComments");

/** The state of the nearest `CommentLayer`, `CommentPanel`, or `provideComments()`, if there is one. Call it in `setup()`. */
export const injectComments = (): CommentsState | undefined => inject(commentsKey, null) ?? undefined;
