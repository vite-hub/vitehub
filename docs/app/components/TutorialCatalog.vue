<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";

const search = ref("");
const selectedCategory = ref("All topics");

const tutorials = docsManifest.sections.flatMap(section => section.pages
  .filter(page => page.layout === "tutorial")
  .map(page => ({
    category: section.id === "getting-started" ? "Get started" : section.category || "Reference",
    description: page.description || "",
    product: section.title,
    project: page.tutorial === "project",
    title: page.sourceTitle || page.title,
    to: page.path,
  })),
);
const categories = ["All topics", ...new Set(tutorials.map(tutorial => tutorial.category))];

const matches = computed(() => {
  const query = search.value.trim().toLowerCase();
  return tutorials.filter(tutorial =>
    (selectedCategory.value === "All topics" || tutorial.category === selectedCategory.value)
    && (!query || `${tutorial.title} ${tutorial.description} ${tutorial.product}`.toLowerCase().includes(query)),
  );
});
const groups = computed(() => [
  {
    id: "projects",
    title: "Build an application",
    description: "Complete projects with runnable source. Each step adds a feature and shows how to check it.",
    tutorials: matches.value.filter(tutorial => tutorial.project),
  },
  {
    id: "quickstarts",
    title: "Learn one feature",
    description: "Short quickstarts from the Docs. Start here to try one API before adding it to your app.",
    tutorials: matches.value.filter(tutorial => !tutorial.project),
  },
].filter(group => group.tutorials.length));

function resetFilters() {
  search.value = "";
  selectedCategory.value = "All topics";
}
</script>

<template>
  <div>
    <div class="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Find a tutorial"
        aria-label="Find a tutorial"
        class="w-full sm:max-w-sm"
      />
      <USelect
        v-model="selectedCategory"
        :items="categories"
        aria-label="Filter tutorials by topic"
        class="w-full sm:w-48"
      />
    </div>

    <p class="sr-only" role="status">{{ matches.length }} tutorials match.</p>

    <section v-for="group in groups" :id="group.id" :key="group.id" :aria-labelledby="`${group.id}-title`" class="mb-12 scroll-mt-8">
      <h2 :id="`${group.id}-title`" class="text-balance text-xl font-semibold text-highlighted">{{ group.title }}</h2>
      <p class="mt-2 mb-5 max-w-2xl text-pretty text-sm leading-6 text-muted">{{ group.description }}</p>
      <template v-if="group.tutorials.length === 1">
        <NuxtLink
          v-for="tutorial in group.tutorials"
          :key="tutorial.to"
          :to="tutorial.to"
          class="group flex items-center gap-4 border-y border-default py-5 hover:bg-elevated/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted"
        >
          <div class="min-w-0 flex-1">
            <p class="text-xs text-muted">{{ tutorial.product }}</p>
            <h3 class="mt-1 text-balance text-lg font-semibold text-highlighted group-hover:underline">{{ tutorial.title }}</h3>
            <p class="mt-2 max-w-3xl text-pretty text-sm leading-6 text-muted">{{ tutorial.description }}</p>
          </div>
          <UIcon name="i-ph-arrow-right-light" class="size-5 shrink-0 text-muted group-hover:text-highlighted" aria-hidden="true" />
        </NuxtLink>
      </template>
      <UBlogPosts v-else class="gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <UBlogPost
          v-for="tutorial in group.tutorials"
          :key="tutorial.to"
          :title="tutorial.title"
          :description="tutorial.description"
          :to="tutorial.to"
          :badge="tutorial.product"
          variant="outline"
          :ui="{ root: 'rounded-lg', body: 'p-5', title: 'text-lg', description: 'text-sm leading-6', header: 'hidden' }"
        />
      </UBlogPosts>
    </section>
    <div v-if="!matches.length" class="py-12 text-center">
      <p class="text-muted">No tutorials match your search.</p>
      <UButton class="mt-3" color="neutral" variant="outline" @click="resetFilters">Clear filters</UButton>
    </div>
  </div>
</template>
