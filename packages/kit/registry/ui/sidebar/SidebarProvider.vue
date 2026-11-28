<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { cn } from "@/lib/utils";
import { sidebarKey } from "./utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
const open = defineModel<boolean>("open", { default: true });
const openMobile = ref(false);
const isMobile = ref(false);
const state = computed(() => (open.value ? "expanded" : "collapsed"));

function toggle() {
  if (isMobile.value) openMobile.value = !openMobile.value;
  else open.value = !open.value;
}

function closeMobile() {
  openMobile.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey) && !event.altKey) {
    event.preventDefault();
    toggle();
  }
}

let query: MediaQueryList | undefined;
const onQuery = () => {
  isMobile.value = query?.matches ?? false;
};

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

provide(sidebarKey, { open, openMobile, isMobile, state, toggle });
</script>

<template>
  <div
    data-slot="sidebar-wrapper"
    :style="{ '--sidebar-width': '16rem', '--sidebar-width-icon': '3rem' }"
    :class="cn('group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar', props.class)"
  >
    <slot :is-mobile="isMobile" :close-mobile="closeMobile" />
  </div>
</template>
