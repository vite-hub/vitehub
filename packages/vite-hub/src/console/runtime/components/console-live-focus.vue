<script setup lang="ts">
import { consoleInitials } from "../client/presence";

import type { ConsoleLivePerson } from "../client/live";

/**
 * Who else edits one field in a live session: a small avatar ringed in each person's caret colour. The colour matches
 * their caret in the body, so the eye can follow one person through the page. The name is in the tooltip and label.
 */
defineProps<{ people: readonly ConsoleLivePerson[] }>();
</script>

<template>
  <span class="flex shrink-0 items-center" role="img" :aria-label="people.map(person => `${person.name} is editing this field`).join(', ')">
    <UTooltip v-for="(person, index) in people.slice(0, 3)" :key="person.clientId" :text="`${person.name} · Editing`" :content="{ side: 'top' }">
      <span
        class="relative inline-flex rounded-full ring-2"
        :class="index ? '-ms-1' : ''"
        :style="{ '--tw-ring-color': person.color, zIndex: 3 - index }"
      >
        <UAvatar :src="person.image" :text="consoleInitials(person.name)" :alt="person.name" size="3xs" />
      </span>
    </UTooltip>
  </span>
</template>
