<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { ArrowDownIcon } from "@lucide/vue";
import { cn } from "@/lib/utils";
import { useMessageList } from "./utils";

const props = withDefaults(defineProps<{ label?: string; class?: HTMLAttributes["class"] }>(), { label: "Scroll to the latest message" });
const { atBottom, scrollToBottom } = useMessageList();
</script>

<template>
  <button
    v-if="!atBottom"
    type="button"
    data-slot="message-list-scroll-button"
    :aria-label="props.label"
    :class="cn('sticky bottom-3 z-10 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center self-center rounded-full bg-popover text-foreground shadow-popover backdrop-blur-xl transition-transform hover:bg-accent active:scale-97 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:size-4', props.class)"
    @click="scrollToBottom()"
  >
    <slot><ArrowDownIcon aria-hidden="true" /></slot>
  </button>
</template>
