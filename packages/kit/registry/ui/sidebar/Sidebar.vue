<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle } from "@ui-sdk/vue/drawer";
import { cn } from "@/lib/utils";
import { useSidebar } from "./utils";

const props = withDefaults(defineProps<{ side?: "left" | "right"; collapsible?: "icon" | "offcanvas" | "none"; label?: string; class?: HTMLAttributes["class"] }>(), {
  side: "left",
  collapsible: "icon",
  label: "Navigation",
});
const { isMobile, openMobile, state } = useSidebar();
</script>

<template>
  <div
    v-if="props.collapsible === 'none'"
    data-slot="sidebar"
    :class="cn('flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground', props.class)"
  >
    <slot />
  </div>

  <Drawer v-else-if="isMobile" v-model:open="openMobile" :side="props.side">
    <DrawerBackdrop class="fixed inset-0 z-50 bg-overlay" />
    <DrawerContent
      data-sidebar="sidebar"
      data-mobile=""
      class="flex h-full w-(--sidebar-width) max-w-[85vw] flex-col bg-sidebar p-0 text-sidebar-foreground shadow-dialog outline-none"
    >
      <DrawerTitle class="sr-only">{{ props.label }}</DrawerTitle>
      <slot />
    </DrawerContent>
  </Drawer>

  <div
    v-else
    data-slot="sidebar"
    class="group peer hidden text-sidebar-foreground md:block"
    :data-state="state"
    :data-collapsible="state === 'collapsed' ? props.collapsible : ''"
    :data-side="props.side"
  >
    <div
      data-slot="sidebar-gap"
      class="relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-out group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[collapsible=offcanvas]:w-0 motion-reduce:transition-none"
    />
    <nav
      data-slot="sidebar-container"
      :aria-label="props.label"
      :class="cn(
        'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-out md:flex motion-reduce:transition-none group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        props.side === 'left'
          ? 'left-0 border-e group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
          : 'right-0 border-s group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
        props.class,
      )"
    >
      <div data-slot="sidebar-inner" class="flex size-full flex-col overflow-hidden bg-sidebar">
        <slot />
      </div>
    </nav>
  </div>
</template>
