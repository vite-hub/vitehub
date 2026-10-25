import type { CommentUser } from "@vite-hub/comments/client";
import type { AvatarStackPerson } from "../components/avatar-stack.ts";

// A user may have no name, as in an Operation user. The id stands in for it.
export const displayName = (user: CommentUser): string => user.name ?? user.id;

export function toPerson(user: CommentUser): AvatarStackPerson {
  return { id: user.id, image: user.image, name: displayName(user) };
}

/** One line of a message for a label: Markdown marks and line breaks gone, and cut at `length`. */
export function excerpt(body: string, length = 60): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
