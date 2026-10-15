<script setup lang="ts">
import { computed, inject } from "vue";

import ConsoleLiveFocus from "./console-live-focus.vue";

import type { ComputedRef } from "vue";
import type { ConsoleLivePerson } from "../client/live";

/**
 * One property row of a document, as in Notion: a compact label column with an icon, then the value. On a phone the
 * label sits above the value, so neither is cut to a few letters. Values are ghost
 * controls that show a border on hover and focus. A required property without a value gets a dot after its label; an
 * invalid one gets its message under the value.
 */
const props = defineProps<{
  description?: string;
  error?: string;
  /** Id of the control the label names. */
  control?: string;
  icon: string;
  label: string;
  /** Required and still empty. */
  missing?: boolean;
}>();

// In a live session, the document editor provides who else focuses each field, keyed by the id of its control.
const fieldPeople = inject<ComputedRef<Record<string, ConsoleLivePerson[]>> | undefined>("vitehubFieldPeople", undefined);
const people = computed(() => (props.control ? fieldPeople?.value[props.control] ?? [] : []));
</script>

<template>
  <div class="grid min-h-8 grid-cols-1 items-start gap-x-1 pb-2 sm:pb-0 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]" :data-vitehub-field="control">
    <label
      :for="control"
      class="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-[13px] text-muted sm:h-8"
      :class="error ? 'text-error' : ''"
      :title="description"
    >
      <UIcon :name="icon" class="size-4 shrink-0 opacity-70" aria-hidden="true" />
      <span class="truncate">{{ label }}</span>
      <span v-if="missing" class="size-1.5 shrink-0 rounded-full bg-error" aria-hidden="true" />
      <span v-if="missing" class="sr-only">(required)</span>
      <ConsoleLiveFocus v-if="people.length" class="ms-auto" :people="people" />
    </label>
    <div class="min-w-0">
      <slot />
      <p v-if="error" :id="control ? `${control}-error` : undefined" class="px-2.5 pt-0.5 pb-1.5 text-xs text-error">{{ error }}</p>
    </div>
  </div>
</template>
