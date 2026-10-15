<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";

import { useConsoleMediaPicker } from "../client/media";
import { consoleFocalCropPosition } from "../client/media-library";
import { useConsoleToast } from "../client/toast";

import type { ConsoleMediaDetails, ConsoleMediaReference } from "../client/media";

/**
 * A Blob reference field, such as `image()` or `file()`, as a property value: a thumbnail and the file name, Replace and
 * Remove, and the alt text of an image, which edits the alt text stored with the file. Choosing goes through the media
 * picker of the section. Without one, the field shows the stored pathname read-only.
 */
const props = defineProps<{
  accept?: readonly string[];
  disabled?: boolean;
  inputId: string;
  kind: "file" | "image";
  label: string;
}>();

const model = defineModel<unknown>();
const picker = useConsoleMediaPicker();
const toast = useConsoleToast();

function record(value: unknown): Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

const reference = computed<ConsoleMediaReference | undefined>(() => {
  const value = record(model.value);
  if (String(value.pathname) !== value.pathname || !value.pathname) return undefined;
  const result: ConsoleMediaReference = { pathname: value.pathname };
  if (String(value.contentType) === value.contentType) result.contentType = value.contentType;
  if (Number.isFinite(value.size)) result.size = Number(value.size);
  return result;
});
const name = computed(() => reference.value?.pathname.slice(reference.value.pathname.lastIndexOf("/") + 1) ?? "");
const details = shallowRef<ConsoleMediaDetails>();
const missing = ref(false);
const alt = ref("");
const altSaved = ref("");
const choosing = ref(false);

watch(() => reference.value?.pathname, async (pathname) => {
  details.value = undefined;
  missing.value = false;
  alt.value = "";
  altSaved.value = "";
  if (!pathname || !picker?.describe || !reference.value) return;
  try {
    const found = await picker.describe(reference.value);
    if (pathname !== reference.value?.pathname) return;
    details.value = found;
    missing.value = !found;
    alt.value = found?.alt ?? "";
    altSaved.value = alt.value;
  }
  catch {
    // A preview that fails to load leaves the name and the actions.
  }
}, { immediate: true });

async function choose(): Promise<void> {
  if (!picker || props.disabled) return;
  choosing.value = true;
  try {
    const [item] = await picker.pick({ accept: props.accept ?? (props.kind === "image" ? ["image/*"] : undefined), files: [], kind: props.kind, multiple: false });
    const picked = item?.reference;
    if (!picked) return;
    const value: Record<string, unknown> = { pathname: picked.pathname };
    if (picked.contentType) value.contentType = picked.contentType;
    if (picked.size !== undefined) value.size = picked.size;
    model.value = value;
  }
  finally {
    choosing.value = false;
  }
}

async function saveAlt(): Promise<void> {
  const text = alt.value.trim();
  if (!reference.value || !picker?.updateAlt || text === altSaved.value) return;
  try {
    await picker.updateAlt(reference.value, text);
    altSaved.value = text;
  }
  catch {
    toast.error("Couldn't save the alt text. Try again.");
  }
}

const meta = computed(() => {
  if (missing.value) return "Missing from the library";
  if (details.value?.width && details.value.height) return `${details.value.width} × ${details.value.height}`;
  return reference.value?.contentType ?? "";
});
</script>

<template>
  <div v-if="!picker" class="flex h-8 min-w-0 items-center gap-2 px-2.5 text-base md:text-sm">
    <span v-if="reference" class="truncate font-mono text-xs text-highlighted">{{ reference.pathname }}</span>
    <span v-else class="text-dimmed">Empty</span>
    <span v-if="reference?.contentType" class="truncate text-xs text-dimmed">{{ reference.contentType }}</span>
  </div>
  <button
    v-else-if="!reference"
    :id="inputId"
    type="button"
    class="vitehub-media-field__empty"
    :disabled="disabled"
    @click="choose"
  >
    <UIcon :name="choosing ? 'i-lucide-loader-circle' : kind === 'image' ? 'i-lucide-image-plus' : 'i-lucide-paperclip'" class="size-4 shrink-0" :class="choosing ? 'animate-spin' : ''" aria-hidden="true" />
    <span>{{ disabled ? "Empty" : kind === "image" ? "Choose an image…" : "Choose a file…" }}</span>
  </button>
  <div v-else class="grid gap-1 py-1">
    <div class="group flex min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1 hover:bg-elevated/50">
      <span class="vitehub-media-field__thumb" :style="{ background: details?.color }">
        <img v-if="details?.thumbnail && kind === 'image'" :src="details.thumbnail" :alt="alt" class="size-full object-cover" :style="{ objectPosition: consoleFocalCropPosition(details.focal, details, 1) }">
        <UIcon v-else :name="missing ? 'i-lucide-triangle-alert' : kind === 'image' ? 'i-lucide-image' : 'i-lucide-file'" class="size-4" :class="missing ? 'text-warning' : 'text-dimmed'" aria-hidden="true" />
      </span>
      <span class="grid min-w-0 flex-1">
        <span class="truncate text-sm text-highlighted" :title="reference.pathname">{{ name }}</span>
        <span class="truncate text-xs tabular-nums" :class="missing ? 'text-warning' : 'text-dimmed'">{{ meta }}</span>
      </span>
      <span v-if="!disabled" class="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <UButton :id="inputId" variant="ghost" size="xs" label="Replace" :loading="choosing" @click="choose" />
        <UButton variant="ghost" size="xs" icon="i-lucide-x" :aria-label="`Remove ${label.toLowerCase()}`" @click="model = undefined" />
      </span>
    </div>
    <UInput
      v-if="kind === 'image' && picker.updateAlt && !missing"
      v-model="alt"
      size="sm"
      variant="ghost"
      class="w-full"
      :disabled="disabled"
      placeholder="Alt text"
      :aria-label="`${label} alt text`"
      :ui="{ base: 'bg-transparent hover:bg-transparent focus:bg-transparent ring-0 hover:ring-1 hover:ring-inset hover:ring-(--ui-border) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--ui-border-accented) text-xs ps-2.5' }"
      @blur="saveAlt"
      @keydown.enter.prevent="saveAlt"
    />
  </div>
</template>

<style>
.vitehub-media-field__empty {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-dimmed);
  display: flex;
  font-size: 0.875rem;
  gap: 0.5rem;
  height: 2rem;
  padding-inline: 0.625rem;
  width: 100%;
}

.vitehub-media-field__empty:not(:disabled):hover {
  box-shadow: inset 0 0 0 1px var(--ui-border);
  color: var(--ui-text-highlighted);
}

.vitehub-media-field__empty:focus-visible {
  box-shadow: inset 0 0 0 1px var(--ui-border-accented);
  outline: none;
}

.vitehub-media-field__thumb {
  align-items: center;
  background: var(--ui-bg-elevated);
  border-radius: 0.25rem;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.06);
  display: inline-flex;
  flex-shrink: 0;
  height: 2.5rem;
  justify-content: center;
  overflow: hidden;
  width: 2.5rem;
}
</style>
