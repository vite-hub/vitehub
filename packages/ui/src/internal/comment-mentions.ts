import type { MarkdownProps } from "@comark/vue";
import { foldName, type CommentUser } from "@vite-hub/comments/client";
import type MarkdownIt from "markdown-it";
import { displayName } from "./comment-person.ts";

type ComarkPlugin = NonNullable<MarkdownProps["plugins"]>[number];

/** The tag of a mention chip in a rendered message. */
export const mentionTag = "comment-mention";

/** A character that may stand before the `@` of a mention: the start of the text, a space, or an opening mark. */
const mentionLead = /[\s([{"'“]/u;

/** The `@…` at the caret: where its `@` sits and the words after it. Names have spaces, so the query may too. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || (start > 0 && !mentionLead.test(before[start - 1]!))) return undefined;
  const query = before.slice(start + 1);
  if (query.length > 40 || /^\s|\n|\s{2}|@/u.test(query)) return undefined;
  return { start, query };
}

export interface RankPeopleOptions {
  /** Ids of people in the conversation. They come first in each group. */
  participants?: readonly string[];
  /** The id of the signed-in user, who is never suggested. */
  exclude?: string;
  limit?: number;
}

/**
 * People whose name starts with the query, then people with a later word that starts with it. People of the
 * conversation come first in each group. A name that matches neither way is left out, so a finished `@Ana Ruiz `
 * does not open the menu again.
 */
export function rankPeople(people: readonly CommentUser[], query: string, options: RankPeopleOptions = {}): CommentUser[] {
  const q = foldName(query);
  const participants = new Set(options.participants);
  const seen = new Set<string>();
  const groups: CommentUser[][] = [[], [], [], []];
  for (const person of people) {
    if (person.id === options.exclude || seen.has(person.id)) continue;
    seen.add(person.id);
    const name = foldName(displayName(person));
    const tier = name.startsWith(q) ? 0 : name.split(/\s+/u).some((word, index) => index > 0 && word.startsWith(q)) ? 1 : undefined;
    if (tier !== undefined) groups[tier * 2 + (participants.has(person.id) ? 0 : 1)]!.push(person);
  }
  return groups.flat().slice(0, options.limit ?? 6);
}

/** A person whose `@name` a message may hold. */
export interface MentionName {
  id: string;
  name: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pluginPeople = new WeakMap<object, readonly MentionName[]>();

/**
 * Splits text at the `@Name` of each person, with the rule of `mentionPlugin()`: the `@` follows a space, an opening
 * mark, or the start, the name ends before a letter or a digit, and longer names win.
 */
export function splitMentions(text: string, people: readonly MentionName[]): Array<string | MentionName> {
  const known = [...people].filter((person) => person.name).sort((a, b) => b.name.length - a.name.length);
  if (known.length === 0) return [text];
  const pattern = new RegExp(`@(${known.map((person) => escape(person.name)).join("|")})(?![\\p{L}\\p{N}_])`, "uy");
  const parts: Array<string | MentionName> = [];
  let start = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && !mentionLead.test(text[at - 1]!)) continue;
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    const person = match && known.find((entry) => entry.name === match[1]);
    if (!match || !person) continue;
    if (at > start) parts.push(text.slice(start, at));
    parts.push(person);
    start = at + match[0].length;
    at = start - 1;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** The people whose `@name` a plugin of `mentionPlugin()` marks, longest name first. A renderer without Markdown-it reads them. */
export function mentionNamesOf(plugin: object): readonly MentionName[] | undefined {
  return pluginPeople.get(plugin);
}

/**
 * A Markdown plugin that turns `@Name` of each given person into a `comment-mention` element. It reads text only, so
 * code spans, code blocks, and link targets keep their `@`. Longer names win, so `@Ana Ruiz` is not cut to `@Ana`, and
 * case does not matter, as in the composer.
 */
export function mentionPlugin(people: readonly MentionName[]): ComarkPlugin {
  const known = [...new Map(people.filter((person) => person.name).map((person) => [person.name, person])).values()]
    .sort((a, b) => b.name.length - a.name.length);
  const pattern = known.length > 0
    ? new RegExp(`@(${known.map((person) => escape(person.name)).join("|")})(?![\\p{L}\\p{N}_])`, "iuy")
    : undefined;
  const plugin: ComarkPlugin = {
    name: "vitehub-comment-mentions",
    markdownItPlugins: [(md: MarkdownIt) => {
      md.inline.ruler.before("text", "vitehub_comment_mention", (state, silent) => {
        if (!pattern || state.src[state.pos] !== "@") return false;
        const lead = state.src[state.pos - 1];
        if (lead !== undefined && !mentionLead.test(lead)) return false;
        pattern.lastIndex = state.pos;
        const match = pattern.exec(state.src);
        if (!match) return false;
        // The composer keeps a mention whose name changed case, such as `@ben soto`, so the chip matches it too.
        const typed = match[1]!.toLowerCase();
        const person = known.find((entry) => entry.name.toLowerCase() === typed);
        if (!person) return false;
        if (!silent) {
          const token = state.push("mdc_inline_component", mentionTag, 0);
          token.attrs = [["user", person.id], ["label", person.name]];
        }
        state.pos += match[0].length;
        return true;
      });
    }],
  };
  pluginPeople.set(plugin, known);
  return plugin;
}
