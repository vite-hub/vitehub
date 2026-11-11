<script setup lang="ts">
import { docsCatalog } from "@vite-hub/docs/navigation";

type CatalogTile = {
  description: string | null;
  icon: string;
  key: string;
  title: string;
  to: string;
};

type CatalogRow = {
  category: string;
  tiles: CatalogTile[];
};

// A tile shows the section's icon, the same one as the rail, the sidebar, and the Console.
const icons = useDocsIcons();
const groups = docsCatalog(useDocsManifest(), useDocsConfig().categories);
const rows = computed<CatalogRow[]>(() => {
  return groups
    .filter(group => group.category !== "Start")
    .map((group) => ({
      category: group.category,
      tiles: group.sections.map(section => ({
          description: section.description,
          icon: icons.section(section),
          key: section.id,
          title: section.title,
          to: section.path,
        })),
    }));
});
</script>

<template>
  <div class="not-prose vh-docs-wide mt-8 flex flex-col gap-9">
    <section v-for="row in rows" :key="row.category">
      <h2 class="mb-3 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.06em] text-muted after:flex-1 after:border-b after:border-default after:content-['']">
        {{ row.category }}
      </h2>
      <UPageGrid>
        <UPageCard
          v-for="tile in row.tiles"
          :key="tile.key"
          :to="tile.to"
          :title="tile.title"
        >
          <template #header>
            <div class="flex h-10 items-center text-muted">
              <UIcon :name="tile.icon" class="size-5" />
            </div>
          </template>
          <template v-if="tile.description" #description>
            <span class="line-clamp-2">{{ tile.description }}</span>
          </template>
        </UPageCard>
      </UPageGrid>
    </section>
  </div>
</template>
