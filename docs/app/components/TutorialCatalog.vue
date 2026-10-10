<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";

const search = ref("");
const selectedCategory = ref("All tutorials");
const categories = ["All tutorials", "Get started", "Data", "Compute", "Access", "Delivery", "Files", "Agents", "Platform"];

const tutorials = docsManifest.sections.flatMap(section => section.pages
  .filter(page => page.layout === "tutorial")
  .map(page => ({
    category: section.id === "getting-started" ? "Get started" : section.category || "Platform",
    description: page.description || "",
    product: section.title,
    title: page.sourceTitle || page.title,
    to: page.path,
  })),
);

const matches = computed(() => {
  const query = search.value.trim().toLowerCase();
  return tutorials.filter(tutorial =>
    (selectedCategory.value === "All tutorials" || tutorial.category === selectedCategory.value)
    && (!query || `${tutorial.title} ${tutorial.description} ${tutorial.product}`.toLowerCase().includes(query)),
  );
});
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

    <UBlogPosts v-if="matches.length" class="gap-5 sm:grid-cols-2 lg:grid-cols-3">
      <UBlogPost
        v-for="tutorial in matches"
        :key="tutorial.to"
        :title="tutorial.title"
        :description="tutorial.description"
        :to="tutorial.to"
        :badge="tutorial.product"
        variant="outline"
        :ui="{ root: 'rounded-lg', body: 'p-5', title: 'text-lg', description: 'text-sm leading-6', header: 'hidden' }"
      />
    </UBlogPosts>
    <p v-else class="py-12 text-center text-muted">No tutorials match your search.</p>
  </div>
</template>
