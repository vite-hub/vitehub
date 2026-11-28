<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { TabsIndicator, TabsList as TabsListPart } from "@ui-sdk/vue/tabs";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <TabsListPart :class="cn('relative flex w-full items-center gap-1 overflow-x-auto border-b data-[orientation=vertical]:w-fit data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[orientation=vertical]:border-e data-[orientation=vertical]:border-b-0', props.class)">
    <slot />
    <TabsIndicator
      class="pointer-events-none absolute bottom-0 left-(--active-tab-left) h-px w-(--active-tab-width) bg-foreground transition-[left,width] duration-200 ease-out data-[activation-direction=none]:transition-none motion-reduce:transition-none data-[orientation=vertical]:top-(--active-tab-top) data-[orientation=vertical]:right-0 data-[orientation=vertical]:bottom-auto data-[orientation=vertical]:left-auto data-[orientation=vertical]:h-(--active-tab-height) data-[orientation=vertical]:w-px data-[orientation=vertical]:transition-[top,height]"
    />
  </TabsListPart>
</template>
