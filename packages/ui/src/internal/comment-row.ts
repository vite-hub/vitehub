import type { CommentThread } from "@vite-hub/comments/client";
import { h } from "vue";
import { AvatarStack } from "../components/avatar-stack.ts";
import { displayName, toPerson } from "./comment-person.ts";
import { timeAgo } from "./comment-time.ts";

function preview(thread: CommentThread): string {
  const text = thread.anchor.kind === "text" ? thread.anchor.exact : "";
  return thread.messages[0]?.body ?? text;
}

/** The inside of one row of a thread list: its number, author, start, and facts. `CommentList` and `CommentPanel` use it. */
export function threadRow(thread: CommentThread, options: { detached?: boolean; site?: boolean } = {}) {
  const replies = thread.messages.length - 1;
  return [
    h("span", { "data-slot": "comment-list-number" }, String(thread.n)),
    h(AvatarStack, { "aria-hidden": "true", people: [toPerson(thread.author)], size: "sm" }),
    h("span", { "data-slot": "comment-list-body" }, [
      h("span", { "data-slot": "comment-list-text" }, preview(thread)),
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
