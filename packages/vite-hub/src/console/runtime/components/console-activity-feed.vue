<script setup lang="ts" generic="T">
import ConsoleState from "./console-state.vue";

/**
 * A list of records in a detail panel, such as the activity of a credential or the grants and approvals of a
 * Connection. It owns the frame that these lists share: a short description with a Refresh button, a compact error,
 * the empty state, a divided list with one `#item` slot per row, and a Load older button. The caller loads the items.
 * - `refresh` shows the Refresh button, and `more` with `hasMore` shows Load older.
 * - The `#notices` slot sits under the error, for a status line such as "Access saved.".
 * - The default slot comes after the list, for paging, a second list, or a form.
 */
const props = withDefaults(
  defineProps<{
    description: string;
    /** Shown when the list has no items, nothing loads, and no error shows. */
    emptyTitle: string;
    emptyDescription?: string;
    emptyIcon?: string;
    error?: unknown;
    errorTitle: string;
    hasMore?: boolean;
    items: readonly T[];
    itemKey: (item: T) => string;
    /** The accessible name of the list, when the panel has more than one. */
    label?: string;
    loading?: boolean;
    more?: () => unknown;
    refresh?: () => unknown;
  }>(),
  { emptyDescription: undefined, emptyIcon: "i-lucide-inbox", error: undefined, hasMore: false, label: undefined, loading: false, more: undefined, refresh: undefined },
);
defineSlots<{
  default?: () => unknown;
  item: (props: { item: T }) => unknown;
  notices?: () => unknown;
}>();
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-muted">{{ description }}</p>
      <UButton v-if="refresh" label="Refresh" variant="ghost" :loading="loading" @click="refresh()" />
    </div>
    <ConsoleState v-if="error" compact :error="error" :title="errorTitle" />
    <slot name="notices" />
    <UEmpty
      v-if="!items.length && !loading && !error"
      variant="naked"
      size="sm"
      :icon="emptyIcon"
      :title="emptyTitle"
      :description="emptyDescription"
    />
    <ol v-if="items.length" role="list" :aria-label="label" class="divide-y divide-default">
      <li v-for="item in items" :key="props.itemKey(item)" class="py-3 text-xs">
        <slot name="item" :item="item" />
      </li>
    </ol>
    <UButton
      v-if="more && hasMore"
      label="Load older activity"
      variant="outline"
      :loading="loading"
      @click="more()"
    />
    <slot />
  </div>
</template>
