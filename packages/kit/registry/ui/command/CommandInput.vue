<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { SearchIcon } from "@lucide/vue";
import { CommandInput as CommandInputPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

defineOptions({ inheritAttrs: false });
const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="command-input-wrapper" class="flex h-11 items-center gap-2 border-b px-3">
    <SearchIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <CommandInputPart
      v-bind="$attrs"
      :class="cn('h-full w-full min-w-0 border-0 bg-transparent p-0 text-base outline-none pointer-fine:text-sm placeholder:text-ui-text-dimmed disabled:cursor-not-allowed disabled:opacity-50', props.class)"
    />
  </div>
</template>
