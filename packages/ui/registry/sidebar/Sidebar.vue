<script setup lang="ts">
import { Drawer, DrawerBackdrop, DrawerContent, DrawerTitle } from "@ui-sdk/vue/drawer";
import { computed } from "vue";
import { useSidebar } from "./context.ts";
import type { SidebarProps, SidebarSlots } from "./types.ts";

const { side = "left", collapsible = "icon", label = "Navigation" } = defineProps<SidebarProps>();
defineSlots<SidebarSlots>();
const { collapsed, isMobile, openMobile } = useSidebar();
const isCollapsed = computed(() => collapsible !== "none" && collapsed.value);
</script>

<template>
  <!-- Narrower than 768px, the sidebar is a sheet that the trigger opens. -->
  <Drawer v-if="isMobile && collapsible !== 'none'" v-model:open="openMobile" :side="side">
    <DrawerBackdrop>
      <template #render="{ props: part }">
        <div v-bind="part" data-slot="sidebar-overlay" />
      </template>
    </DrawerBackdrop>
    <!-- ui-sdk handles Escape and the Tab trap only on `drawer-content`, so the mobile sidebar keeps that slot. -->
    <DrawerContent data-sidebar="" :aria-label="label">
      <DrawerTitle>
        <template #render="{ props: part, children }">
          <h2 v-bind="part" data-slot="sidebar-title"><component :is="children" /></h2>
        </template>
        {{ label }}
      </DrawerTitle>
      <slot />
    </DrawerContent>
  </Drawer>

  <div
    v-else
    data-slot="sidebar"
    :data-side="side"
    :data-collapsible="collapsible"
    :data-collapsed="isCollapsed ? '' : undefined"
  >
    <div data-slot="sidebar-gap" />
    <nav data-slot="sidebar-container" :aria-label="label">
      <div data-slot="sidebar-inner"><slot /></div>
    </nav>
  </div>
</template>
