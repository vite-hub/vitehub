<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Textarea } from "@ui-sdk/vue/textarea";
import { cn } from "@/lib/utils";
import { usePromptInput } from "./utils";

const props = withDefaults(defineProps<{ placeholder?: string; label?: string; class?: HTMLAttributes["class"] }>(), {
  placeholder: "Send a message",
  label: "Message",
});
const { text, pending, submit } = usePromptInput();
const touchOnly = ref(false);
const enterSends = computed(() => !pending.value && !touchOnly.value);
let coarsePointer: MediaQueryList | undefined;
let finePointer: MediaQueryList | undefined;

function updateTouchOnly() {
  touchOnly.value = coarsePointer?.matches === true && finePointer?.matches === false;
}

onMounted(() => {
  coarsePointer = window.matchMedia("(pointer: coarse)");
  finePointer = window.matchMedia("(any-pointer: fine)");
  updateTouchOnly();
  coarsePointer.addEventListener("change", updateTouchOnly);
  finePointer.addEventListener("change", updateTouchOnly);
});

onBeforeUnmount(() => {
  coarsePointer?.removeEventListener("change", updateTouchOnly);
  finePointer?.removeEventListener("change", updateTouchOnly);
});

function onKeydown(event: KeyboardEvent) {
  if (!enterSends.value || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
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
    :enterkeyhint="enterSends ? 'send' : 'enter'"
    :class="cn('max-h-48 min-h-12 w-full resize-none border-0 bg-transparent px-3 pt-3 pb-1 text-base text-foreground outline-none pointer-fine:text-sm placeholder:text-ui-text-dimmed', props.class)"
    @keydown="onKeydown"
  />
</template>
