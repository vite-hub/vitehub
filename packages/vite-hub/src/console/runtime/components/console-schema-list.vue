<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { consoleItemTitle, consoleSchemaItemValue } from "../client/schema-form";

import type { ConsoleSchemaField } from "../client/schema-form";

/**
 * The items of a list field, such as the links of a navigation menu. An item that is an object is one row with its
 * title and detail, and opens in place to show its fields. Any other item is one row with its control. Each row can
 * move up, move down, or be removed, and Add appends a new item. The item controls come from the `item` slot.
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
watch(() => items.value.length, (length) => {
  if (keys.value.length !== length) keys.value = Array.from({ length }, () => nextKey++);
}, { immediate: true });
const open = ref(new Set<number>());

function itemId(index: number): string {
  return `${props.inputId}-${keys.value[index] ?? index}`;
}

function title(value: unknown, index: number): { detail?: string, title: string } {
  const result = consoleItemTitle(props.field.item, value);
  return result.title ? result : { ...result, title: `${props.field.item.label} ${index + 1}` };
}

function write(next: unknown[], nextKeys: number[]): void {
  keys.value = nextKeys;
  model.value = next;
}

function update(index: number, value: unknown): void {
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
  [next[index], next[target]] = [next[target], next[index]];
  [nextKeys[index], nextKeys[target]] = [nextKeys[target]!, nextKeys[index]!];
  write(next, nextKeys);
  // Keep focus on the same button of the moved row, so several moves need no pointer.
  void focus(() => document.getElementById(`${itemId(target)}-${offset < 0 ? "up" : "down"}`));
}

function remove(index: number): void {
  const key = keys.value[index]!;
  const next = items.value.filter((_, position) => position !== index);
  write(next, keys.value.filter((_, position) => position !== index));
  const remaining = new Set(open.value);
  remaining.delete(key);
  open.value = remaining;
  void focus(() => document.getElementById(next.length ? `${itemId(Math.min(index, next.length - 1))}-remove` : `${props.inputId}-add`));
}

async function add(): Promise<void> {
  const key = nextKey++;
  write([...items.value, consoleSchemaItemValue(props.field.item)], [...keys.value, key]);
  if (objectItems.value) open.value = new Set(open.value).add(key);
  // The first control of the new item: a field of an object item, or the item's own input.
  const selector = objectItems.value ? "input, textarea, button[role=combobox]" : "input, textarea, button[role=combobox], button[role=switch]";
  await focus(() => document.getElementById(objectItems.value ? `${props.inputId}-${key}-fields` : `${props.inputId}-${key}`)?.querySelector<HTMLElement>(selector));
}

function toggle(index: number): void {
  const key = keys.value[index]!;
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}

const action = "size-6 justify-center text-dimmed hover:text-highlighted";
</script>

<template>
  <div class="grid grid-cols-1 ms-3 border-s border-default ps-[calc(0.75rem-1px)]">
    <ol class="grid grid-cols-1" :aria-label="field.label">
      <li v-for="(value, index) in items" :id="itemId(index)" :key="keys[index]" class="group/item grid grid-cols-1">
        <div class="flex min-h-8 items-start gap-1">
          <button
            v-if="objectItems"
            type="button"
            class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-base hover:bg-elevated/70 focus-visible:outline-2 md:text-sm"
            :aria-expanded="open.has(keys[index]!)"
            :aria-controls="`${itemId(index)}-fields`"
            @click="toggle(index)"
          >
            <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 text-dimmed" :class="open.has(keys[index]!) ? 'rotate-90' : ''" aria-hidden="true" />
            <span class="truncate text-highlighted">{{ title(value, index).title }}</span>
            <span v-if="title(value, index).detail" class="min-w-0 truncate text-dimmed">{{ title(value, index).detail }}</span>
          </button>
          <div v-else class="min-w-0 flex-1">
            <slot name="item" :id="itemId(index)" :depth="depth + 1" :index="index" :value="value" :update="(next: unknown) => update(index, next)" />
          </div>
          <div v-if="!disabled" class="flex h-8 shrink-0 items-center opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 max-sm:opacity-100">
            <UButton :id="`${itemId(index)}-up`" icon="i-lucide-arrow-up" size="xs" variant="ghost" color="neutral" :class="action" :disabled="index === 0" :aria-label="`Move ${title(value, index).title} up`" @click="move(index, -1)" />
            <UButton :id="`${itemId(index)}-down`" icon="i-lucide-arrow-down" size="xs" variant="ghost" color="neutral" :class="action" :disabled="index === items.length - 1" :aria-label="`Move ${title(value, index).title} down`" @click="move(index, 1)" />
            <UButton :id="`${itemId(index)}-remove`" icon="i-lucide-x" size="xs" variant="ghost" color="neutral" :class="action" :aria-label="`Remove ${title(value, index).title}`" @click="remove(index)" />
          </div>
        </div>
        <div v-if="objectItems && open.has(keys[index]!)" :id="`${itemId(index)}-fields`" class="grid grid-cols-1 ms-3 border-s border-default ps-[calc(0.75rem-1px)]">
          <slot name="item" :id="itemId(index)" :depth="depth + 2" :index="index" :value="value" :update="(next: unknown) => update(index, next)" />
        </div>
      </li>
    </ol>
    <UButton
      v-if="!disabled"
      :id="`${inputId}-add`"
      icon="i-lucide-plus"
      size="sm"
      variant="ghost"
      color="neutral"
      class="w-fit px-1.5 text-[13px] font-normal text-dimmed hover:text-highlighted"
      :label="`Add ${noun}`"
      @click="add"
    />
  </div>
</template>
