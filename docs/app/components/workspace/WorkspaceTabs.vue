<script setup lang="ts" generic="T extends string">
// Tabs at the bottom of a workspace. Hidden tabs stay mounted, so the terminal keeps its output.
defineProps<{
  items: { label: string, value: T, icon: string, badge?: string }[]
}>();
const value = defineModel<T>({ required: true });
</script>

<template>
  <UTabs
    v-model="value"
    :items="items.map(item => ({ ...item, slot: item.value }))"
    :unmount-on-hide="false"
    class="vh-tabs"
  >
    <template v-for="item in items" :key="item.value" #[item.value]>
      <slot :name="item.value" />
    </template>
  </UTabs>
</template>

<style scoped>
/* The tabs fill the workspace panel: the strip keeps its height, and the active panel takes the rest. */
.vh-tabs {
  min-width: 0;
  min-height: 0;
  flex: 1;
  gap: 0;
}

.vh-tabs :deep([data-slot="list"]) {
  flex: none;
}

.vh-tabs :deep([data-slot="content"]) {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

/* Reka keeps hidden panels mounted but visible, so they hide here. */
.vh-tabs :deep([data-slot="content"][data-state="inactive"]) {
  display: none;
}
</style>
