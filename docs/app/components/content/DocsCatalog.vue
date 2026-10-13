<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { docsRootSectionId, getDocsCatalog, getDocsSectionKind } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

type CatalogTile = {
  description: string | null;
  icon: string;
  kind: string;
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

const rows = computed<CatalogRow[]>(() => {
  const catalogRows = getDocsCatalog(docsManifest.sections).map((group) => {
    const startSection = group.category === "Start"
      ? group.sections.find(section => section.id === docsRootSectionId)
      : null;

    // The Start row lists the ungrouped pages of the Start section. Every other row lists one tile per product.
    const tiles: CatalogTile[] = startSection
      ? startSection.pages
          .filter(page => page.navigation !== false && !page.group)
          .map(page => ({
            description: page.description,
            icon: sidebarPageIcon(page),
            kind: "Getting started",
            key: page.path,
            scene: null,
            title: page.sourceTitle || page.title,
            to: page.path,
          }))
      : group.sections.map(section => ({
          description: section.description,
          icon: sidebarSectionIcon(section),
          kind: getDocsSectionKind(section),
          key: section.id,
          scene: scenes.get(section.id) ?? null,
          title: section.title,
          to: section.path,
        }));

    return { category: group.category, tiles };
  });

  const startSection = docsManifest.sections.find(section => section.id === docsRootSectionId);
  const learnTiles = startSection?.pages
    .filter(page => page.navigation !== false && ["Concepts", "AI resources"].includes(page.group || ""))
    .map(page => ({
      description: page.description,
      icon: sidebarPageIcon(page),
      kind: page.group || "Learn",
      key: page.path,
      scene: null,
      title: page.sourceTitle || page.title,
      to: page.path,
    })) || [];

  if (!learnTiles.length) return catalogRows;
  const startIndex = catalogRows.findIndex(row => row.category === "Start");
  const insertAt = startIndex < 0 ? 0 : startIndex + 1;
  return [
    ...catalogRows.slice(0, insertAt),
    { category: "Learn", tiles: learnTiles },
    ...catalogRows.slice(insertAt),
  ];
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
  <div ref="catalog" class="not-prose vh-docs-catalog">
    <section v-for="row in rows" :key="row.category" class="vh-docs-catalog-row">
      <h2 class="vh-docs-catalog-heading">{{ row.category === "Start" ? "Get started" : row.category }}</h2>
      <ul class="vh-docs-catalog-grid" role="list">
        <li v-for="(tile, index) in row.tiles" :key="tile.key" class="min-w-0">
          <NuxtLink :to="tile.to" class="vh-docs-catalog-tile group">
            <div class="vh-docs-catalog-tile-visual">
              <LandingPrimitiveMotion
                v-if="tile.scene"
                :name="tile.scene"
                :play="visible"
                :offset="offset(index)"
              />
              <UIcon v-else :name="tile.icon" class="size-5" />
            </div>
            <div class="min-w-0">
              <p class="vh-docs-catalog-tile-kind">{{ tile.kind }}</p>
              <h3 class="vh-docs-catalog-tile-title">
                <span>{{ tile.title }}</span>
                <UIcon name="i-lucide-arrow-right" class="vh-docs-catalog-tile-arrow size-3.5 shrink-0" aria-hidden="true" />
              </h3>
              <p v-if="tile.description" class="vh-docs-catalog-tile-description">{{ tile.description }}</p>
              <span class="vh-docs-catalog-tile-action">
                View {{ tile.kind === "Getting started" ? "guide" : "docs" }}
                <UIcon name="i-lucide-arrow-up-right" class="size-3.5 shrink-0" aria-hidden="true" />
              </span>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.vh-docs-catalog {
  display: flex;
  flex-direction: column;
  gap: 2.25rem;
  margin-top: 2rem;
}

.vh-docs-catalog-heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-docs-catalog-heading::after {
  content: "";
  flex: 1;
  border-bottom: 1px solid var(--ui-border);
}

/* Each tile draws its right and bottom line, so a short last row leaves no filler cells. */
.vh-docs-catalog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
  list-style: none;
}

.vh-docs-catalog-grid > li {
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
}

@media (min-width: 40rem) {
  .vh-docs-catalog-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .vh-docs-catalog-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.vh-docs-catalog-tile {
  --tile-bg: var(--ui-bg);
  display: flex;
  height: 100%;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--tile-bg);
  transition: background-color 200ms ease;
}

.vh-docs-catalog-tile:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vh-docs-catalog-tile-visual {
  display: flex;
  height: 2.5rem;
  width: 100%;
  align-items: center;
  color: var(--ui-text-muted);
  transition: color 200ms ease;
}

.vh-docs-catalog-tile-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
}

.vh-docs-catalog-tile-kind {
  margin: 0 0 0.25rem;
  color: var(--ui-text-dimmed);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1;
  text-transform: uppercase;
}

.vh-docs-catalog-tile-arrow {
  opacity: 0;
  transform: translateX(-0.25rem);
  transition: opacity 200ms ease, transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.vh-docs-catalog-tile-description {
  display: -webkit-box;
  margin: 0.125rem 0 0;
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  line-height: 1.125rem;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.vh-docs-catalog-tile-action {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: auto;
  padding-top: 0.75rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

@media (hover: hover) and (pointer: fine) {
  .vh-docs-catalog-tile:hover {
    --tile-bg: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
  }

  .vh-docs-catalog-tile:hover .vh-docs-catalog-tile-visual {
    color: var(--ui-text-highlighted);
  }

  .vh-docs-catalog-tile:hover .vh-docs-catalog-tile-arrow,
  .vh-docs-catalog-tile:focus-visible .vh-docs-catalog-tile-arrow {
    opacity: 1;
    transform: translateX(0);
  }

  .vh-docs-catalog-tile:hover .vh-docs-catalog-tile-action,
  .vh-docs-catalog-tile:focus-visible .vh-docs-catalog-tile-action {
    color: var(--ui-text-highlighted);
  }
}

.vh-docs-catalog-tile:active {
  transition-duration: 80ms;
  --tile-bg: color-mix(in srgb, var(--ui-bg-muted) 60%, var(--ui-bg));
}

@media (prefers-reduced-motion: reduce) {
  .vh-docs-catalog-tile,
  .vh-docs-catalog-tile-visual,
  .vh-docs-catalog-tile-arrow {
    transition: none;
    transform: none;
  }
}
</style>
