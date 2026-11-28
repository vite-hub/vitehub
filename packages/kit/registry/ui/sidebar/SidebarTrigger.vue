<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { PanelLeftIcon } from "@lucide/vue";
import { cn } from "@/lib/utils";
import { useSidebar } from "./utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
const { isMobile, open, openMobile, toggle } = useSidebar();
</script>

<template>
  <button
    type="button"
    data-slot="sidebar-trigger"
    aria-label="Toggle sidebar"
    aria-keyshortcuts="Control+B Meta+B"
    :aria-expanded="isMobile ? openMobile : open"
    :class="cn('inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-accent hover:text-foreground active:scale-97 motion-reduce:active:scale-100 [&_svg]:size-4', props.class)"
    @click="toggle"
  >
    <PanelLeftIcon aria-hidden="true" class="rtl:rotate-180" />
  </button>
</template>
