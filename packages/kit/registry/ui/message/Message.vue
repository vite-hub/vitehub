<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(defineProps<{ from?: "user" | "assistant" | "system"; class?: HTMLAttributes["class"] }>(), { from: "assistant" });
</script>

<template>
  <div
    data-slot="message"
    :data-from="props.from"
    :class="cn('group/message flex w-full min-w-0 flex-col gap-1.5 data-[from=user]:items-end', props.class)"
  >
    <slot />
  </div>
</template>
