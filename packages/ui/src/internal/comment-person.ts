import type { CommentUser } from "@vite-hub/comments/client";
import type { AvatarStackPerson } from "../components/avatar-stack.ts";

// A user may have no name, as in an Operation user. The id stands in for it.
export const displayName = (user: CommentUser): string => user.name ?? user.id;

export function toPerson(user: CommentUser): AvatarStackPerson {
  return { id: user.id, image: user.image, name: displayName(user) };
}

/**
 * The text of a Markdown message without its Markdown, for a preview: `**Pro**` shows as `Pro`, a link as its text, and an
 * image as its alt text. Mentions are text already, so `@Ana Ruiz` stays.
 */
export function plainText(body: string): string {
  // An escaped mark is text. Hide it from the rules below, then put it back.
  let text = body
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_, mark: string) => String.fromCharCode(0xe000 + mark.charCodeAt(0)))
    .replace(/^\s*(?:```|~~~).*$/gm, "")
    .replace(/^\s*::+[\w-]*(?:\{[^}\n]*\})?\s*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "");
  // Three passes undo nested marks, such as `**a _b_**`. An underscore inside a word, as in snake_case, is not a mark.
  for (let pass = 0; pass < 3; pass++) {
    text = text
      .replace(/(`+)([^`]+?)\1/g, "$2")
      .replace(/(\*\*|~~|\*)(?=\S)(.*?\S)\1/g, "$2")
      .replace(/(?<![\p{L}\p{N}_])(__|_)(?=\S)(.*?\S)\1(?![\p{L}\p{N}_])/gu, "$2");
  }
  return text
    .replace(/[\ue000-\ue07f]/g, (mark) => String.fromCharCode(mark.charCodeAt(0) - 0xe000))
    .replace(/\s+/g, " ")
    .trim();
}

/** One line of a message for a label: Markdown marks and line breaks gone, and cut at `length`. */
export function excerpt(body: string, length = 60): string {
  const line = plainText(body);
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
