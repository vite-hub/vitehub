import Fuse from "fuse.js";

import type { ConsoleDocumentState } from "./documents";

/** A command of a Console command list, such as the search palette. */
export interface ConsoleCommand {
  label: string;
  description?: string;
  /** Text after the label, such as the collection of a document. Search matches it. */
  suffix?: string;
  /** An Iconify name, such as `i-lucide-plus`. */
  icon?: string;
  /** Keys shown at the end of the row, such as `["g", "o"]`. The command list does not bind them. */
  kbds?: string[];
  /** Extra words that find the command, such as `images` for Media. */
  keywords?: string[];
  disabled?: boolean;
  /** Shows a spinner instead of the icon while the command runs. */
  loading?: boolean;
  /** Marks the current choice, such as the theme in use. */
  active?: boolean;
  /** `section` draws the section icon of the rail. `document` leads with the state dot of the document. */
  kind?: "document" | "section";
  state?: ConsoleDocumentState;
  stateLabel?: string;
  /** Commands of a nested page. Choosing the command opens the page, and Backspace in the empty field goes back. */
  children?: ConsoleCommand[];
  /** The field placeholder on the nested page. */
  placeholder?: string;
  onSelect?: (event?: Event) => void;
}

/** What search reads from a command. */
export interface ConsoleSearchableCommand {
  label: string;
  description?: string;
  suffix?: string;
  keywords?: string[];
}

export interface ConsoleCommandGroup<Item extends ConsoleSearchableCommand = ConsoleCommand> {
  id: string;
  label?: string;
  items: Item[];
  /** The items are already matches, such as server results, so search shows all of them. */
  ignoreFilter?: boolean;
}

export interface ConsoleCommandFilterOptions {
  /** Also match each word of the query by itself, so `go to` finds `Toggle theme` through `to`. */
  tokens?: boolean;
  /** Keep the groups in their order. Without it, the group of the best match comes first. */
  preserveGroupOrder?: boolean;
  /** Search the keywords too. */
  keywords?: boolean;
}

/** At most this many matches in all, and this many items in each group. */
export const consoleCommandResultLimit = 12;

/**
 * The groups and items that a query shows, with the ranking of the Nuxt UI command palette that the Console used
 * before: Fuse.js with a 0.1 threshold anywhere in the text, at most 12 matches in all, the best match first in each
 * group, and at most 12 items in a group. An empty query shows every item.
 */
export function filterConsoleCommandGroups<Item extends ConsoleSearchableCommand>(
  groups: readonly ConsoleCommandGroup<Item>[],
  query: string,
  options: ConsoleCommandFilterOptions = {},
): ConsoleCommandGroup<Item>[] {
  const searchable = groups.filter(group => !group.ignoreFilter).flatMap(group => group.items.map(item => ({ group: group.id, item })));
  const matches = query
    ? new Fuse(searchable, {
        ignoreLocation: true,
        // Label, description, and suffix count twice as much as keywords, as in the Nuxt UI palette.
        keys: [
          { name: ["item", "label"], weight: 2 },
          { name: ["item", "description"], weight: 2 },
          { name: ["item", "suffix"], weight: 2 },
          ...(options.keywords ? [{ name: ["item", "keywords"], weight: 1 }] : []),
        ],
        threshold: 0.1,
        useTokenSearch: options.tokens ?? false,
      }).search(query, { limit: consoleCommandResultLimit }).map(result => result.item)
    : searchable;
  const byGroup = new Map<string, Item[]>();
  for (const { group, item } of matches) byGroup.set(group, [...byGroup.get(group) ?? [], item]);
  const shown = (group: ConsoleCommandGroup<Item>): ConsoleCommandGroup<Item> | undefined => {
    const items = (group.ignoreFilter ? group.items : byGroup.get(group.id) ?? []).slice(0, consoleCommandResultLimit);
    return items.length ? { ...group, items } : undefined;
  };
  if (options.preserveGroupOrder) return groups.flatMap(group => shown(group) ?? []);
  // The group of the best match first. A group that search does not filter keeps its place after the groups before it.
  const result = [...byGroup.keys()].flatMap(id => shown(groups.find(group => group.id === id)!) ?? []);
  for (const [index, group] of groups.entries()) {
    const entry = group.ignoreFilter ? shown(group) : undefined;
    if (!entry) continue;
    const before = new Set(groups.slice(0, index).map(candidate => candidate.id));
    const at = result.findLastIndex(candidate => before.has(candidate.id));
    result.splice(at + 1, 0, entry);
  }
  return result;
}
