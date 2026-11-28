<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { onBeforeUnmount, onMounted, provide, ref } from "vue";
import { cn } from "@/lib/utils";
import { messageListKey } from "./utils";

const props = withDefaults(defineProps<{ label?: string; class?: HTMLAttributes["class"] }>(), { label: "Messages" });

const viewport = ref<HTMLElement>();
const content = ref<HTMLElement>();
const atBottom = ref(true);
let lastTop = 0;
let observer: ResizeObserver | undefined;

const distanceToBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight;

function scrollToBottom(behavior: ScrollBehavior = "smooth") {
  const element = viewport.value;
  if (!element) return;
  atBottom.value = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollTo({ top: element.scrollHeight, behavior: reduce ? "instant" : behavior });
}

function onScroll() {
  const element = viewport.value;
  if (!element) return;
  if (distanceToBottom(element) < 32) atBottom.value = true;
  else if (element.scrollTop < lastTop - 1) atBottom.value = false;
  lastTop = element.scrollTop;
}

onMounted(() => {
  scrollToBottom("instant");
  observer = new ResizeObserver(() => {
    if (atBottom.value) scrollToBottom("instant");
  });
  if (content.value) observer.observe(content.value);
  if (viewport.value) observer.observe(viewport.value);
});

onBeforeUnmount(() => observer?.disconnect());

provide(messageListKey, { atBottom, scrollToBottom });
defineExpose({ scrollToBottom });
</script>

<template>
  <div
    ref="viewport"
    data-slot="message-list"
    role="log"
    :aria-label="props.label"
    tabindex="0"
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
    @scroll.passive="onScroll"
  >
    <div ref="content" data-slot="message-list-content" :class="cn('mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6', props.class)">
      <slot />
    </div>
  </div>
</template>
