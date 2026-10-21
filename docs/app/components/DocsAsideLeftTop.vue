<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsSectionForPath,
  getDocsSectionSelectItems,
  type DocsSectionSelectItem,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const router = useRouter();

const items = getDocsSectionSelectItems(docsManifest.sections);
const currentSection = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const selectedSectionId = computed({
  get: () => currentSection.value?.id,
  set: (sectionId: string | undefined) => {
    const target = items.flat().find(item => item.value === sectionId);
    if (target?.to && target.value !== currentSection.value?.id) void router.push(target.to);
  },
});

function itemIcon(item: DocsSectionSelectItem) {
  return item.value ? sidebarSectionIcon({ id: item.value, icon: item.icon ?? null }) : undefined;
}
</script>

<template>
  <div class="vh-sidebar-head">
    <UContentSearchButton
      :collapsed="false"
      class="vh-sidebar-search"
      :ui="{
        base: 'h-10 rounded-none border-0 border-b border-default bg-muted/20 ps-5 pe-5 text-muted hover:bg-muted/40 hover:text-highlighted',
        trailing: 'ms-auto flex items-center gap-1',
      }"
    />

    <USelectMenu
      v-model="selectedSectionId"
      :items="items"
      value-key="value"
      :search-input="false"
      :icon="currentSection ? sidebarSectionIcon(currentSection) : 'i-ph-squares-four-light'"
      trailing-icon="i-ph-caret-down-light"
      placeholder="All products"
      aria-label="Documentation product"
      class="vh-docs-product-select"
      :ui="{
        base: 'w-full h-10 rounded-none border-0 border-b border-default bg-default ps-11 pe-10 text-sm font-semibold text-highlighted ring-0 hover:bg-muted/30 focus-visible:ring-0',
        leading: 'ps-5',
        leadingIcon: 'size-4 text-muted',
        trailing: 'pe-4',
        trailingIcon: 'size-4 text-muted',
        content: 'rounded-md',
        label: 'px-2 pt-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-dimmed',
      }"
    >
      <template #item-leading="{ item }">
        <UIcon v-if="itemIcon(item)" :name="itemIcon(item)!" class="size-4 shrink-0 text-muted" />
      </template>
    </USelectMenu>
  </div>
</template>

<style scoped>
.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}

.vh-docs-product-select {
  width: 100%;
}
</style>
