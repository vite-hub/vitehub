<script setup lang="ts">
import { Plus } from "@lucide/vue";
import { onScopeDispose, useAttrs, useTemplateRef } from "vue";
import { usePromptInput } from "./context.ts";
import type { PromptInputAttachProps, PromptInputAttachSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
const { variant = "outline", disabled = false, label = "Add attachment" } = defineProps<PromptInputAttachProps>();
defineSlots<PromptInputAttachSlots>();
const attrs = useAttrs();
const context = usePromptInput();
const input = useTemplateRef<HTMLInputElement>("input");
// The prompt takes files while an attach button that is not disabled is in it, so a paste adds files too.
if (context) onScopeDispose(context.addAttach(() => disabled));
const locked = () => disabled || (context?.disabled.value ?? true);

async function onChange(event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLInputElement) || !context) return;
  await context.addFiles(target.files ?? []);
  target.value = "";
}
</script>

<template>
  <template v-if="context">
    <input
      ref="input"
      type="file"
      data-slot="visually-hidden"
      tabindex="-1"
      :accept="context.accept.value"
      :aria-label="label"
      :disabled="locked()"
      :multiple="!context.single.value"
      @change="onChange"
    >
    <button
      v-bind="attrs"
      type="button"
      data-slot="prompt-input-attach"
      :data-variant="variant"
      :aria-label="label"
      :disabled="locked()"
      @click="input?.click()"
    >
      <slot><Plus data-slot="prompt-input-attach-icon" aria-hidden="true" /></slot>
    </button>
  </template>
</template>
