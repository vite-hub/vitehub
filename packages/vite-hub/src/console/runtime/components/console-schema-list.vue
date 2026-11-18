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
 * shows Undo for a few seconds, and only then the item leaves the value.
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
/** Rows whose remove waits for its Undo window to pass. */
const pending = ref(new Set<number>());
const rows = ref<Record<number, HTMLElement | null>>({});

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

function setPending(key: number, value: boolean): void {
  const next = new Set(pending.value);
  if (value) next.add(key);
  else next.delete(key);
  pending.value = next;
}

/** Removes the row with `key` once its Undo window has passed. The row may have moved since the hold. */
function remove(key: number): void {
  setPending(key, false);
  const index = keys.value.indexOf(key);
  if (index === -1) return;
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

</script>

<template>
  <div class="grid grid-cols-1 ms-3 border-s border-default ps-[calc(0.75rem-1px)]">
    <MotionList tag="ol" class="grid grid-cols-1" :aria-label="field.label">
      <li v-for="(value, index) in items" :id="itemId(index)" :key="keys[index]" class="group/item relative grid grid-cols-1">
        <p v-if="pending.has(keys[index]!)" class="flex h-8 min-w-0 items-center px-1.5 text-sm text-dimmed">
          <span class="truncate">Removed {{ title(value, index).title }}</span>
        </p>
        <div v-show="!pending.has(keys[index]!)" :ref="(element) => { rows[keys[index]!] = element as HTMLElement | null }" class="flex min-h-8 items-start gap-1" :class="disabled ? '' : 'pe-7'">
          <!-- A field value, not an action: it reads in the type of the ghost fields of the form, which UButton does not. -->
          <button
            v-if="objectItems"
            type="button"
            class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-elevated pointer-coarse:text-base"
            :aria-expanded="open.has(keys[index]!)"
            :aria-controls="`${itemId(index)}-fields`"
            @click="toggle(index)"
          >
            <Icon name="i-lucide-chevron-right" class="size-3.5 shrink-0 text-dimmed" :class="open.has(keys[index]!) ? 'rotate-90' : ''" aria-hidden="true" />
            <span class="truncate text-highlighted">{{ title(value, index).title }}</span>
            <span v-if="title(value, index).detail" class="min-w-0 truncate text-dimmed">{{ title(value, index).detail }}</span>
          </button>
          <div v-else class="min-w-0 flex-1">
            <slot name="item" :id="itemId(index)" :depth="depth + 1" :index="index" :value="value" :update="(next: unknown) => update(index, next)" />
          </div>
          <div v-if="!disabled" class="flex h-8 shrink-0 items-center opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 max-sm:opacity-100">
            <UButton :id="`${itemId(index)}-up`" icon="i-lucide-arrow-up" size="xs" variant="ghost" :disabled="index === 0" :aria-label="`Move ${title(value, index).title} up`" @click="move(index, -1)" />
            <UButton :id="`${itemId(index)}-down`" icon="i-lucide-arrow-down" size="xs" variant="ghost" :disabled="index === items.length - 1" :aria-label="`Move ${title(value, index).title} down`" @click="move(index, 1)" />
          </div>
        </div>
        <!-- One button for remove and Undo, so it keeps its state while the row waits for the Undo window. -->
        <HoldToDelete
          v-if="!disabled"
          :id="`${itemId(index)}-remove`"
          label=""
          class="absolute end-0 top-0.5"
          :class="pending.has(keys[index]!) ? '' : 'opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100 max-sm:opacity-100'"
          :aria-label="pending.has(keys[index]!) ? `Undo removing ${title(value, index).title}` : `Hold to remove ${title(value, index).title}`"
          :item="() => rows[keys[index]!]"
          :commit="() => remove(keys[index]!)"
          :confirm="() => true"
          @delete="setPending(keys[index]!, true)"
          @undo="setPending(keys[index]!, false)"
        />
        <div v-if="objectItems && open.has(keys[index]!) && !pending.has(keys[index]!)" :id="`${itemId(index)}-fields`" class="grid grid-cols-1 ms-3 border-s border-default ps-[calc(0.75rem-1px)]">
          <slot name="item" :id="itemId(index)" :depth="depth + 2" :index="index" :value="value" :update="(next: unknown) => update(index, next)" />
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
