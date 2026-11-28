<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Textarea } from "@ui-sdk/vue/textarea";
import { cn } from "@/lib/utils";
import { usePromptInput } from "./utils";

const props = withDefaults(defineProps<{ placeholder?: string; label?: string; class?: HTMLAttributes["class"] }>(), {
  placeholder: "Send a message",
  label: "Message",
});
const { text, submit } = usePromptInput();

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  submit();
}
</script>

<template>
  <Textarea
    v-model:value="text"
    auto-resize
    :placeholder="props.placeholder"
    :aria-label="props.label"
    enterkeyhint="send"
    :class="cn('max-h-48 min-h-12 w-full resize-none border-0 bg-transparent px-3 pt-3 pb-1 text-base text-foreground outline-none pointer-fine:text-sm placeholder:text-ui-text-dimmed', props.class)"
    @keydown="onKeydown"
  />
</template>
