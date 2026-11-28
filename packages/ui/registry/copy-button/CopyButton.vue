<script setup lang="ts">
import "../core/vitehub.css";
import "./copy-button.css";
import { Check, Copy, LoaderCircle } from "@lucide/vue";
import { Button } from "@ui-sdk/vue/button";
import { computed, onMounted, ref, useSlots, useTemplateRef, watch } from "vue";
import { announce, prepareAnnouncer } from "../core/announce.ts";
import type { CopyButtonEmits, CopyButtonProps, CopyButtonSlots } from "./types.ts";
import { type CopyValue, useCopy } from "./use-copy.ts";

const {
  value,
  label,
  copyLabel = "Copy",
  copiedLabel = "Copied",
  failedLabel = "Copy failed",
  variant = "ghost",
  size = "sm",
  duration = 2_000,
  preload = false,
  disabled = false,
} = defineProps<CopyButtonProps>();
const emit = defineEmits<CopyButtonEmits>();
const slots = useSlots();
defineSlots<CopyButtonSlots>();

const { copy, copied } = useCopy({ duration: () => duration });
const root = useTemplateRef<{ $el?: Element }>("root");
const element = () => (root.value?.$el instanceof Element ? root.value.$el : undefined);
onMounted(() => prepareAnnouncer(element()));

// The text that a hover or a focus started to load, for the next click. A failed load is dropped, so the click tries again.
let preloaded: { text: string | Promise<string> } | undefined;
watch(() => value, () => (preloaded = undefined));
function startPreload() {
  if (!preload || preloaded || typeof value !== "function") return;
  const entry = { text: callValue(value) };
  preloaded = entry;
  if (typeof entry.text === "string") return;
  entry.text.then(
    (text) => {
      if (preloaded === entry) entry.text = text;
    },
    () => {
      if (preloaded === entry) preloaded = undefined;
    },
  );
}

const loading = ref(false);
async function onClick() {
  let text: CopyValue = value;
  if (typeof text === "function") {
    // Call it during the click, and show the loading icon only when the text has to load first. A promise goes to
    // the clipboard inside the click, so the browser accepts the write after the text loads.
    const pending = preloaded?.text ?? callValue(text);
    preloaded = undefined;
    text = typeof pending === "string" ? pending : () => pending;
    loading.value = typeof pending !== "string";
  }
  const ok = await copy(text);
  loading.value = false;
  announce(element(), ok ? copiedLabel : failedLabel, duration);
  if (ok) emit("copy");
  else emit("error");
}

const name = computed(() => (label || slots.default ? undefined : copyLabel));

/** Calls a function `value`. A function that throws gives a rejected promise, so the copy reports the failure. */
function callValue(read: () => string | Promise<string>): string | Promise<string> {
  try {
    return read();
  }
  catch (error) {
    return Promise.reject(error);
  }
}
</script>

<template>
  <Button
    ref="root"
    data-slot="copy-button"
    :data-variant="variant"
    :data-size="size"
    :data-copied="copied ? '' : undefined"
    :data-loading="loading ? '' : undefined"
    :aria-label="name"
    :disabled="disabled || loading"
    @click="onClick"
    @focus="startPreload"
    @pointerenter="startPreload"
  >
    <!-- The ui-sdk Button writes data-slot="button". The render slot keeps the item's own data-slot on the root. -->
    <template #render="{ props: part, children }">
      <button v-bind="part" data-slot="copy-button"><component :is="children" /></button>
    </template>
    <LoaderCircle v-if="loading" data-slot="copy-button-icon" aria-hidden="true" />
    <slot v-else-if="copied" name="copied-icon"><Check data-slot="copy-button-icon" aria-hidden="true" /></slot>
    <slot v-else name="icon"><Copy data-slot="copy-button-icon" aria-hidden="true" /></slot>
    <span v-if="label || slots.default" data-slot="copy-button-label">
      <slot>{{ copied && label ? copiedLabel : label }}</slot>
    </span>
  </Button>
</template>
