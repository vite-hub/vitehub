<script setup lang="ts">
import { HoldToDelete, MotionList } from "@vite-hub/ui";
import { computed, nextTick, ref, watch } from "vue";

import { consoleItemTitle, consoleSchemaItemValue } from "../client/schema-form";

import type { ConsoleSchemaField } from "../client/schema-form";
import Icon from "./console-icon.vue";

/**
 * The items of a list field, such as the links of a navigation menu. An item that is an object is one row with its
 * title and detail, and opens in place to show its fields. Any other item is one row with its control. Each row can
 * move up, move down, or be removed, and Add appends a new item. The item controls come from the `item` slot.
 *
 * Rows move with the list mover of @vite-hub/ui. Remove is a hold: the row's content leaves toward the trash, the row
 * shows Undo for a few seconds. The value changes at once, so form actions see the removal.
 */
const props = defineProps<{
  disabled?: boolean;
  /** Nesting level of the list's own row. Items sit one level deeper. */
  depth: number;
  field: ConsoleSchemaField & { item: ConsoleSchemaField };
  /** Id of the list's property row. Item ids start with it. */
  inputId: string;
}>();

defineSlots<{
  item(props: { depth: number, id: string, index: number, update: (value: unknown) => void, value: unknown }): unknown;
}>();

const model = defineModel<unknown>();

const items = computed(() => (Array.isArray(model.value) ? model.value : []));
const objectItems = computed(() => props.field.item.kind === "object");
const noun = computed(() => props.field.item.label.toLowerCase());

// Stable keys for the rows, so an open item stays open when it moves. Values have no ids of their own.
let nextKey = 0;
const keys = ref<number[]>([]);
const pending = ref(new Map<number, unknown>());
const activeKeys = computed(() => keys.value.filter(key => !pending.value.has(key)));
watch(() => items.value.length, (length) => {
  if (activeKeys.value.length === length) return;
  keys.value = Array.from({ length }, () => nextKey++);
  pending.value.clear();
}, { immediate: true });
const open = ref(new Set<number>());
const rows = ref<Record<number, HTMLElement | null>>({});
const displayRows = computed(() => {
  let index = 0;
  return keys.value.map((key) => {
    if (pending.value.has(key)) return { key, index, value: pending.value.get(key), removed: true };
    return { key, index, value: items.value[index++], removed: false };
  });
});

function itemId(key: number): string {
  return `${props.inputId}-${key}`;
}

function title(value: unknown, index: number): { detail?: string, title: string } {
  const result = consoleItemTitle(props.field.item, value);
  return result.title ? result : { ...result, title: `${props.field.item.label} ${index + 1}` };
}

function write(next: unknown[], nextKeys: number[]): void {
  keys.value = nextKeys;
  model.value = next;
}

function update(key: number, value: unknown): void {
  const index = activeKeys.value.indexOf(key);
  if (index === -1) return;
  const next = [...items.value];
  next[index] = value;
  model.value = next;
}

/** Focuses an element once the list has rendered the change, which goes through the parent form first. */
async function focus(find: () => HTMLElement | null | undefined): Promise<void> {
  for (let frame = 0; frame < 3; frame++) {
    await nextTick();
    const element = find();
    if (element) {
      element.focus();
      return;
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

function move(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= items.value.length) return;
  const next = [...items.value];
  const nextKeys = [...keys.value];
  const key = activeKeys.value[index]!;
  const targetKey = activeKeys.value[target]!;
  const from = nextKeys.indexOf(key);
  const to = nextKeys.indexOf(targetKey);
  [next[index], next[target]] = [next[target], next[index]];
  [nextKeys[from], nextKeys[to]] = [targetKey, key];
  write(next, nextKeys);
  // Keep focus on the same button of the moved row, so several moves need no pointer.
  void focus(() => document.getElementById(`${itemId(key)}-${offset < 0 ? "up" : "down"}`));
}

function remove(key: number): void {
  const index = activeKeys.value.indexOf(key);
  if (index === -1) return;
  pending.value.set(key, items.value[index]);
  model.value = items.value.filter((_, position) => position !== index);
}

function undo(key: number): void {
  if (!pending.value.has(key)) return;
  const next = [...items.value];
  const value = pending.value.get(key);
  pending.value.delete(key);
  next.splice(activeKeys.value.indexOf(key), 0, value);
  model.value = next;
}

function dismiss(key: number): void {
  if (!pending.value.has(key)) return;
  const index = displayRows.value.find(row => row.key === key)?.index ?? 0;
  keys.value = keys.value.filter(candidate => candidate !== key);
  pending.value.delete(key);
  open.value.delete(key);
  if (document.activeElement?.id !== `${itemId(key)}-remove`) return;
  const next = activeKeys.value[index] ?? activeKeys.value.at(-1);
  void focus(() => document.getElementById(next === undefined ? `${props.inputId}-add` : `${itemId(next)}-remove`));
}

async function add(): Promise<void> {
  const key = nextKey++;
  write([...items.value, consoleSchemaItemValue(props.field.item)], [...keys.value, key]);
  if (objectItems.value) open.value = new Set(open.value).add(key);
  // The first control of the new item: a field of an object item, or the item's own input.
  const selector = objectItems.value ? "input, textarea, button[role=combobox]" : "input, textarea, button[role=combobox], button[role=switch]";
  await focus(() => document.getElementById(objectItems.value ? `${props.inputId}-${key}-fields` : `${props.inputId}-${key}`)?.querySelector<HTMLElement>(selector));
}

function toggle(key: number): void {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}

</script>

<template>
  <div class="grid grid-cols-1 ms-3 border-s border-default ps-[calc(0.75rem-1px)]">
    <MotionList tag="ol" class="grid grid-cols-1" :aria-label="field.label">
      <li v-for="{ key, index, value, removed } in displayRows" :id="itemId(key)" :key="key" class="group/item relative grid grid-cols-1">
        <p v-if="removed" class="flex h-8 min-w-0 items-center px-1.5 text-sm text-dimmed">
          <span class="truncate">Removed {{ title(value, index).title }}</span>
        </p>
        <div v-else :ref="(element) => { rows[key] = element as HTMLElement | null }" class="flex min-h-8 items-start gap-1" :class="disabled ? '' : 'pe-7'">
          <!-- A field value, not an action: it reads in the type of the ghost fields of the form, which UButton does not. -->
          <button
            v-if="objectItems"
            type="button"
            class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-elevated pointer-coarse:text-base"
            :aria-expanded="open.has(key)"
            :aria-controls="`${itemId(key)}-fields`"
            @click="toggle(key)"
          >
            <Icon name="i-lucide-chevron-right" class="size-3.5 shrink-0 text-dimmed" :class="open.has(key) ? 'rotate-90' : ''" aria-hidden="true" />
            <span class="truncate text-highlighted">{{ title(value, index).title }}</span>
            <span v-if="title(value, index).detail" class="min-w-0 truncate text-dimmed">{{ title(value, index).detail }}</span>
          </button>
          <div v-else class="min-w-0 flex-1">
            <slot name="item" :id="itemId(key)" :depth="depth + 1" :index="index" :value="value" :update="(next: unknown) => update(key, next)" />
          </div>
          <div v-if="!disabled" class="flex h-8 shrink-0 items-center opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 max-sm:opacity-100">
            <UButton :id="`${itemId(key)}-up`" icon="i-lucide-arrow-up" size="xs" variant="ghost" :disabled="index === 0" :aria-label="`Move ${title(value, index).title} up`" @click="move(index, -1)" />
            <UButton :id="`${itemId(key)}-down`" icon="i-lucide-arrow-down" size="xs" variant="ghost" :disabled="index === items.length - 1" :aria-label="`Move ${title(value, index).title} down`" @click="move(index, 1)" />
          </div>
        </div>
        <!-- One button for remove and Undo, so it keeps its state while the row waits for the Undo window. -->
        <HoldToDelete
          v-if="!disabled"
          :id="`${itemId(key)}-remove`"
          label=""
          class="absolute end-0 top-0.5"
          :class="removed ? '' : 'opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100 max-sm:opacity-100'"
          :aria-label="removed ? `Undo removing ${title(value, index).title}` : `Hold to remove ${title(value, index).title}`"
          :item="() => rows[key]"
          :commit="() => dismiss(key)"
          :confirm="() => true"
          @delete="remove(key)"
          @undo="undo(key)"
        />
        <div v-if="objectItems && open.has(key) && !removed" :id="`${itemId(key)}-fields`" class="grid grid-cols-1 ms-3 border-s border-default ps-[calc(0.75rem-1px)]">
          <slot name="item" :id="itemId(key)" :depth="depth + 2" :index="index" :value="value" :update="(next: unknown) => update(key, next)" />
        </div>
      </li>
    </MotionList>
    <UButton
      v-if="!disabled"
      :id="`${inputId}-add`"
      icon="i-lucide-plus"
      variant="ghost"
      class="w-fit"
      :label="`Add ${noun}`"
      @click="add"
    />
  </div>
</template>
