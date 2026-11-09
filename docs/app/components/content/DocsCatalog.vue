<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { docsCatalog } from "@vite-hub/docs/navigation";

type CatalogTile = {
  description: string | null;
  icon: string;
  key: string;
  /** Landing scene name when the product has a looping micro-animation. */
  scene: string | null;
  title: string;
  to: string;
};

type CatalogRow = {
  category: string;
  tiles: CatalogTile[];
};

/** Products that share a looping scene with the landing page grid. */
const scenes = new Map([
  ["agents", "agent"],
  ["auth", "auth"],
  ["blob", "blob"],
  ["browser", "browser"],
  ["cms", "cms"],
  ["comments", "comments"],
  ["connections", "connections"],
  ["content", "content"],
  ["database", "database"],
  ["env", "env"],
  ["email", "email"],
  ["channels", "channels"],
  ["kv", "kv"],
  ["queue", "queue"],
  ["rate-limit", "rate-limit"],
  ["realtime", "realtime"],
  ["sandbox", "sandbox"],
  ["schedule", "schedule"],
  ["shell", "shell"],
  ["source", "source"],
  ["workspace", "workspace"],
  ["workflows", "workflow"],
]);

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
          scene: scenes.get(section.id) ?? null,
          title: section.title,
          to: section.path,
        })),
    }));
});

const catalog = useTemplateRef<HTMLElement>("catalog");
const visible = ref(false);

// Scenes loop only while the catalog is on screen.
useIntersectionObserver(
  catalog,
  ([entry]) => {
    visible.value = entry?.isIntersecting ?? false;
  },
  { threshold: 0.05 },
);

// Spread start points across the loop so neighboring tiles do not move together.
function offset(index: number) {
  return (index * 0.37) % 1;
}
</script>

<template>
  <div ref="catalog" class="not-prose vh-docs-wide mt-8 flex flex-col gap-9">
    <section v-for="row in rows" :key="row.category">
      <h2 class="mb-3 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.06em] text-muted after:flex-1 after:border-b after:border-default after:content-['']">
        {{ row.category }}
      </h2>
      <UPageGrid>
        <UPageCard
          v-for="(tile, index) in row.tiles"
          :key="tile.key"
          :to="tile.to"
          :title="tile.title"
        >
          <template #header>
            <div class="flex h-10 items-center text-muted">
              <LandingPrimitiveMotion
                v-if="tile.scene"
                :name="tile.scene"
                :play="visible"
                :offset="offset(index)"
              />
              <UIcon v-else :name="tile.icon" class="size-5" />
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
