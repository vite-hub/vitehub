import type { CommentThread } from "@vite-hub/comments/client";
import { h, type VNodeChild } from "vue";
import { AvatarStack } from "../components/avatar-stack.ts";
import { displayName, plainText, toPerson } from "./comment-person.ts";
import { timeAgo } from "./comment-time.ts";

/** The start of a thread as plain text: its first message, else the text that it is about. */
export function threadPreview(thread: CommentThread): string {
  const text = thread.anchor.kind === "text" ? thread.anchor.exact : "";
  return plainText(thread.messages[0]?.body ?? "") || text;
}

export interface ThreadRowOptions {
  detached?: boolean;
  site?: boolean;
  /** Replaces the text of the row, such as the content of a `preview` slot. */
  preview?: VNodeChild;
}

/** The inside of one row of a thread list: its number, author, start, and facts. `CommentList` and `CommentPanel` use it. */
export function threadRow(thread: CommentThread, options: ThreadRowOptions = {}) {
  const replies = thread.messages.length - 1;
  return [
    h("span", { "data-slot": "comment-list-number" }, String(thread.n)),
    h(AvatarStack, { "aria-hidden": "true", people: [toPerson(thread.author)], size: "sm" }),
    h("span", { "data-slot": "comment-list-body" }, [
      h("span", { "data-slot": "comment-list-text" }, options.preview ?? threadPreview(thread)),
      h("span", { "data-slot": "comment-list-meta" }, [
        h("span", displayName(thread.author)),
        h("span", timeAgo(thread.updatedAt)),
        replies > 0 ? h("span", `${replies} ${replies === 1 ? "reply" : "replies"}`) : null,
        thread.status === "resolved" ? h("span", "Resolved") : null,
        options.detached ? h("span", { "data-slot": "comment-list-detached" }, "Detached") : null,
        options.site && thread.subject.kind === "page" ? h("span", thread.subject.id) : null,
      ]),
    ]),
  ];
}
