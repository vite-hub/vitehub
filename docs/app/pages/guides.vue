<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";

const search = ref("");
const selectedCategory = ref("All guides");
const categories = ["All guides", "Get started", "Data", "Compute", "Access", "Delivery", "Files", "Agents", "Platform"];

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

const guides = computed(() => {
  const query = search.value.trim().toLowerCase();
  return tutorials.filter(guide =>
    (selectedCategory.value === "All guides" || guide.category === selectedCategory.value)
    && (!query || `${guide.title} ${guide.description} ${guide.product}`.toLowerCase().includes(query)),
  );
});

useSeoMeta({
  title: "Guides",
  ogTitle: "Guides · ViteHub",
  description: "Build your first ViteHub route, Agent, or server feature with step-by-step tutorials.",
});
</script>

<template>
  <main>
    <UContainer class="mx-auto w-full !max-w-7xl !px-4 py-10 sm:!px-6 sm:py-14 lg:!px-8">
      <UPageHeader
        title="Guides"
        description="Build a working feature, one step at a time. Each tutorial includes the files to create and a result you can check."
        :ui="{ root: 'border-0 pt-0 pb-8', description: 'max-w-2xl', title: 'text-3xl sm:text-4xl' }"
      />

      <div class="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Find a guide"
          aria-label="Find a guide"
          class="w-full sm:max-w-sm"
        />
        <USelect
          v-model="selectedCategory"
          :items="categories"
          aria-label="Filter guides by topic"
          class="w-full sm:w-44"
        />
      </div>

      <UBlogPosts v-if="guides.length" class="gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <UBlogPost
          v-for="guide in guides"
          :key="guide.to"
          :title="guide.title"
          :description="guide.description"
          :to="guide.to"
          :badge="guide.product"
          variant="outline"
          :ui="{ root: 'rounded-lg', body: 'p-5', title: 'text-lg', description: 'text-sm leading-6', header: 'hidden' }"
        />
      </UBlogPosts>
      <p v-else class="py-12 text-center text-muted">No guides match your search.</p>

      <p class="mt-10 text-sm text-muted">
        Need an API option or deployment detail?
        <NuxtLink to="/docs" class="text-highlighted underline underline-offset-4">Browse the documentation</NuxtLink>.
      </p>
    </UContainer>
  </main>
</template>
