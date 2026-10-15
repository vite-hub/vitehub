<script setup lang="ts">
import { computed } from "vue";

import { consoleInitials } from "../client/presence";

import type { ConsoleDocumentSession, ConsoleDocumentSessionUser } from "../client/documents";

/**
 * Who else has a document open, as overlapping avatars: the first three, then `+N`. Editors come first. In a header each
 * avatar says `Ana · Editing` or `Ana · Viewing`; in a list row one avatar says `Ana is editing`.
 */
const props = withDefaults(defineProps<{
  sessions: readonly ConsoleDocumentSession[];
  /** The signed-in user, so another tab of theirs reads as "You". */
  user?: ConsoleDocumentSessionUser | null;
  /** `row` shows one small avatar for list rows and the dashboard. */
  variant?: "header" | "row";
}>(), { user: null, variant: "header" });

/** One avatar per person: two tabs of one person show once, as editing when either edits. */
const people = computed(() => {
  const byUser = new Map<string, ConsoleDocumentSession>();
  for (const session of props.sessions) {
    // A row does not show you viewing in another tab; it shows you editing there, since that blocks this tab.
    if (props.variant === "row" && props.user && session.user.id === props.user.id && session.kind === "view") continue;
    const known = byUser.get(session.user.id);
    if (!known || (known.kind === "view" && session.kind === "edit")) byUser.set(session.user.id, session);
  }
  return [...byUser.values()].sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "edit" ? -1 : 1));
});
const shown = computed(() => people.value.slice(0, props.variant === "row" ? 1 : 3));
const hidden = computed(() => people.value.slice(shown.value.length));

function nameOf(session: ConsoleDocumentSession): string {
  return props.user && session.user.id === props.user.id ? "You" : session.user.name;
}

function describe(session: ConsoleDocumentSession): string {
  const name = nameOf(session);
  const own = name === "You";
  if (props.variant === "row") {
    if (own) return session.kind === "edit" ? "You're editing this in another tab" : "You have this open in another tab";
    return session.kind === "edit" ? `${name} is editing` : `${name} is viewing`;
  }
  return `${name} · ${session.kind === "edit" ? "Editing" : "Viewing"}${own ? " in another tab" : ""}`;
}

const label = computed(() => people.value.map(describe).join(", "));
</script>

<template>
  <span v-if="people.length" class="flex shrink-0 items-center" role="img" :aria-label="label">
    <UTooltip v-for="(session, index) in shown" :key="session.user.id" :text="describe(session)" :content="{ side: 'bottom' }">
      <span
        class="relative inline-flex rounded-full ring-2 ring-(--ui-bg)"
        :class="[index ? '-ms-1.5' : '', session.kind === 'view' ? 'opacity-60' : '']"
        :style="{ zIndex: shown.length - index }"
      >
        <UAvatar :src="session.user.image" :text="consoleInitials(session.user.name)" :alt="session.user.name" :size="variant === 'row' ? '2xs' : 'xs'" />
      </span>
    </UTooltip>
    <UTooltip v-if="hidden.length" :text="hidden.map(describe).join(', ')" :content="{ side: 'bottom' }">
      <span
        class="relative -ms-1.5 inline-flex items-center justify-center rounded-full bg-elevated px-1.5 text-xs/none font-medium text-muted tabular-nums ring-2 ring-(--ui-bg)"
        :class="variant === 'row' ? 'h-5 min-w-5' : 'h-6 min-w-6'"
      >+{{ hidden.length }}</span>
    </UTooltip>
  </span>
</template>
