<script setup lang="ts">
import { Drawer } from "@ui-sdk/vue/drawer";

const props = withDefaults(defineProps<{ side?: "top" | "right" | "bottom" | "left" }>(), { side: "right" });
</script>

<template>
  <Drawer :side="props.side">
    <slot />
  </Drawer>
</template>
