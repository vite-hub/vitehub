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
    :items="items.map(item => ({ ...item, slot: item.value, badge: item.badge ? { label: item.badge, color: 'neutral', variant: 'soft' } : undefined }))"
    variant="link"
    size="xs"
    color="neutral"
    :unmount-on-hide="false"
    class="vh-tabs"
    :ui="{ list: 'vh-tabs-list', trigger: 'h-9', content: 'vh-tabs-content data-[state=inactive]:hidden', indicator: 'bottom-0' }"
  >
    <template v-for="item in items" :key="item.value" #[item.value]>
      <slot :name="item.value" />
    </template>
  </UTabs>
</template>

<style scoped>
.vh-tabs {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 0;
}

.vh-tabs :deep(.vh-tabs-list) {
  flex: none;
  height: 2.25rem;
  gap: 0.25rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.25rem;
}

.vh-tabs :deep(.vh-tabs-content) {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
</style>
