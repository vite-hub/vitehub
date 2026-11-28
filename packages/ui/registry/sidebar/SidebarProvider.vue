<script setup lang="ts">
import "../core/vitehub.css";
import "./sidebar.css";
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { sidebarKey } from "./context.ts";
import type { SidebarProviderEmits, SidebarProviderProps, SidebarProviderSlots } from "./types.ts";

const { defaultCollapsed = false } = defineProps<SidebarProviderProps>();
const collapsed = defineModel<boolean | undefined>("collapsed", { default: undefined });
defineEmits<SidebarProviderEmits>();
defineSlots<SidebarProviderSlots>();

const isCollapsed = computed({
  get: () => collapsed.value ?? defaultCollapsed,
  set: (next: boolean) => {
    collapsed.value = next;
  },
});
const openMobile = ref(false);
const isMobile = ref(false);

function toggle() {
  if (isMobile.value) openMobile.value = !openMobile.value;
  else isCollapsed.value = !isCollapsed.value;
}

function closeMobile() {
  openMobile.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    toggle();
  }
}

let query: MediaQueryList | undefined;
function onQuery() {
  isMobile.value = query?.matches ?? false;
}

onMounted(() => {
  query = window.matchMedia("(max-width: 767px)");
  onQuery();
  query.addEventListener("change", onQuery);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  query?.removeEventListener("change", onQuery);
  window.removeEventListener("keydown", onKeydown);
});

provide(sidebarKey, { collapsed: isCollapsed, openMobile, isMobile, toggle });
</script>

<template>
  <div data-slot="sidebar-wrapper" :data-collapsed="isCollapsed ? '' : undefined">
    <slot :is-mobile="isMobile" :close-mobile="closeMobile" />
  </div>
</template>
