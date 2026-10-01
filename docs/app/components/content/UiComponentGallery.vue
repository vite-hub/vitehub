<script setup lang="ts">
import { computed } from "vue";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";

const props = withDefaults(
  defineProps<{
    /** Sidebar groups to leave out, for example the Start group that holds this page. */
    exclude?: string[];
  }>(),
  {
    exclude: () => ["Start"],
  },
);

// Read the generated docs manifest so the gallery follows the UI sidebar order and groups.
const groups = computed(() => {
  const section = docsManifest.sections.find((candidate) => candidate.id === "ui");
  const grouped = new Map<string, NonNullable<typeof section>["pages"]>();
  for (const page of section?.pages ?? []) {
    const label = page.group?.trim();
    if (!label || page.navigation === false || props.exclude.includes(label)) continue;
    grouped.set(label, [...(grouped.get(label) ?? []), page]);
  }
  return [...grouped].map(([label, pages]) => ({
    id: `ui-gallery-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
    label,
    pages,
  }));
});
</script>

<template>
  <div class="not-prose my-8 space-y-10">
    <section v-for="group in groups" :key="group.label" :aria-labelledby="group.id">
      <div class="mb-3 flex items-baseline justify-between gap-4 border-b border-default pb-2">
        <h3 :id="group.id" class="text-sm font-semibold text-highlighted">
          {{ group.label }}
        </h3>
        <span class="font-mono text-xs text-muted">{{ group.pages.length }}</span>
      </div>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="page in group.pages" :key="page.path">
          <NuxtLink
            :to="page.path"
            class="group flex h-full gap-3 rounded-lg border border-default bg-default p-4 transition-colors hover:border-accented hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted"
          >
            <span class="grid size-9 shrink-0 place-items-center rounded-md border border-default bg-elevated/60 text-muted transition-colors group-hover:text-highlighted">
              <UIcon :name="page.icon || 'i-ph-squares-four-light'" class="size-5" aria-hidden="true" />
            </span>
            <span class="min-w-0">
              <span class="block text-sm font-medium text-highlighted">{{ page.title }}</span>
              <span v-if="page.description" class="mt-1 line-clamp-2 block text-xs leading-5 text-muted">
                {{ page.description }}
              </span>
            </span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>
