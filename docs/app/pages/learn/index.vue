<script setup lang="ts">
import { learnFacts } from "#build/learn-facts.mjs";
import { playgroundTemplates } from "#build/playground-templates.mjs";
import { runnableTutorials } from "#build/runnable-tutorials.mjs";
import { buildLearnCatalog, filterQuickstarts, learnMeta } from "~/utils/learn-catalog";

// Get started lists this page, so it opens in the docs layout with the sidebar.
definePageMeta({ layout: "docs" });

const title = "Learn ViteHub";
const description = "Build your first ViteHub app in the browser, then add one primitive at a time to your own app.";
useSeoMeta({ title, ogTitle: title, description, ogDescription: description });

const catalog = buildLearnCatalog({ sections: useDocsManifest().sections, runnable: runnableTutorials, facts: learnFacts });
const first = catalog.browser[0];
const templates = playgroundTemplates.map(template => ({ id: template.id, label: template.label, description: template.description }));

const search = ref("");
const quickstarts = computed(() => filterQuickstarts(catalog.quickstarts, search.value));
const quickstartCount = computed(() => quickstarts.value.reduce((count, group) => count + group.entries.length, 0));
</script>

<template>
  <main class="vh-learn">
    <!-- Hero: what you build, and one way to start. -->
    <section class="vh-learn-hero" aria-labelledby="learn-title">
      <div class="vh-learn-hero-copy">
        <p class="text-sm font-medium text-muted">Learn</p>
        <h1 id="learn-title" class="mt-3 text-balance text-4xl font-semibold tracking-tight text-highlighted sm:text-5xl">
          Build your first ViteHub app in the browser
        </h1>
        <p class="mt-5 max-w-xl text-pretty text-lg leading-8 text-muted">
          Follow a short lesson next to a live editor. Each step runs a real Vite server in this tab, so you install nothing.
        </p>
        <div v-if="first" class="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
          <UButton size="lg" color="neutral" :to="first.to" trailing-icon="i-lucide-arrow-right" label="Start the KV tutorial" />
        </div>
        <p v-if="first" class="mt-4 text-sm text-dimmed">
          {{ learnMeta(first) }} · Chrome, Edge, or Firefox on a desktop
        </p>
      </div>

      <figure class="vh-learn-shot">
        <img src="/images/learn-workspace-light.webp" width="1440" height="856" alt="The First Server Primitive tutorial: the lesson on the left, and the editor with a running preview on the right." class="dark:hidden" fetchpriority="high">
        <img src="/images/learn-workspace-dark.webp" width="1440" height="856" alt="" aria-hidden="true" class="hidden dark:block" loading="lazy">
      </figure>
    </section>

    <!-- Runnable tutorials, in the order to take them. -->
    <section class="vh-learn-section" aria-labelledby="learn-browser">
      <header class="vh-learn-section-header">
        <h2 id="learn-browser" class="vh-learn-h2">Start in your browser</h2>
        <p class="vh-learn-lead">Each lesson runs beside an editor and a live preview. Check every step before you go on.</p>
      </header>
      <ol class="grid gap-4 md:grid-cols-2">
        <li v-for="(entry, index) in catalog.browser" :key="entry.to">
          <NuxtLink :to="entry.to" class="vh-learn-card group">
            <div class="flex items-center gap-3">
              <span class="vh-learn-index" aria-hidden="true">{{ index + 1 }}</span>
              <UIcon v-if="entry.icon" :name="entry.icon" class="size-5 text-muted" aria-hidden="true" />
            </div>
            <h3 class="mt-5 text-lg font-semibold text-highlighted">{{ entry.title }}</h3>
            <p class="mt-2 text-pretty text-sm leading-6 text-muted">{{ entry.description }}</p>
            <p class="vh-learn-meta mt-auto pt-5">
              <span>{{ learnMeta(entry) }}</span>
              <span class="inline-flex items-center gap-1.5"><UIcon name="i-lucide-app-window" class="size-3.5" aria-hidden="true" />Runs in your browser</span>
            </p>
            <span class="vh-learn-cta">Start tutorial<UIcon name="i-lucide-arrow-right" class="size-4 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" /></span>
          </NuxtLink>
        </li>
      </ol>
    </section>

    <!-- Complete projects. -->
    <section v-if="catalog.projects.length" class="vh-learn-section" aria-labelledby="learn-projects">
      <header class="vh-learn-section-header">
        <h2 id="learn-projects" class="vh-learn-h2">Build a full app</h2>
        <p class="vh-learn-lead">A complete project on your machine. Each step adds a feature and shows how to check it.</p>
      </header>
      <div class="grid gap-4">
        <NuxtLink v-for="entry in catalog.projects" :key="entry.to" :to="entry.to" class="vh-learn-card vh-learn-card--wide group">
          <UIcon v-if="entry.icon" :name="entry.icon" class="size-6 shrink-0 text-muted" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-xs text-muted">{{ entry.product }}</p>
            <h3 class="mt-1 text-lg font-semibold text-highlighted">{{ entry.title }}</h3>
            <p class="mt-2 max-w-3xl text-pretty text-sm leading-6 text-muted">{{ entry.description }}</p>
            <p class="vh-learn-meta mt-4">
              <span>{{ learnMeta(entry) }}</span>
              <span class="inline-flex items-center gap-1.5"><UIcon name="i-lucide-laptop" class="size-3.5" aria-hidden="true" />On your machine</span>
            </p>
          </div>
          <UIcon name="i-lucide-arrow-right" class="size-5 shrink-0 self-center text-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-highlighted" aria-hidden="true" />
        </NuxtLink>
      </div>
    </section>

    <!-- Playground templates: one primitive each, running at once. -->
    <section class="vh-learn-section" aria-labelledby="learn-playground">
      <header class="vh-learn-section-header">
        <h2 id="learn-playground" class="vh-learn-h2">Try a primitive in the playground</h2>
        <p class="vh-learn-lead">Open a small app that uses one primitive, change the code, and see the result. No lesson, no setup.</p>
      </header>
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="template in templates" :key="template.id">
          <NuxtLink :to="template.id === templates[0]?.id ? '/playground' : `/playground?template=${template.id}`" class="vh-learn-tile group">
            <span class="font-medium text-highlighted">{{ template.label }}</span>
            <span class="text-sm text-muted">{{ template.description }}</span>
            <UIcon name="i-lucide-arrow-up-right" class="vh-learn-tile-icon" aria-hidden="true" />
          </NuxtLink>
        </li>
      </ul>
    </section>

    <!-- Quickstarts from the docs, by primitive. -->
    <section class="vh-learn-section" aria-labelledby="learn-quickstarts">
      <header class="vh-learn-section-header sm:flex sm:items-end sm:justify-between sm:gap-6">
        <div>
          <h2 id="learn-quickstarts" class="vh-learn-h2">Add one primitive to your app</h2>
          <p class="vh-learn-lead">Short quickstarts from the docs. Each one adds a single primitive to an app you already have.</p>
        </div>
        <UInput v-model="search" icon="i-lucide-search" placeholder="Search quickstarts" aria-label="Search quickstarts" class="mt-4 w-full sm:mt-0 sm:w-64" />
      </header>
      <p class="sr-only" role="status">{{ quickstartCount }} quickstarts match.</p>

      <div v-if="quickstarts.length" class="vh-learn-groups">
        <section v-for="group in quickstarts" :key="group.product" :aria-label="group.product" class="vh-learn-group">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon v-if="group.icon" :name="group.icon" class="size-4 text-muted" aria-hidden="true" />
            {{ group.product }}
          </h3>
          <ul class="mt-2">
            <li v-for="entry in group.entries" :key="entry.to">
              <NuxtLink :to="entry.to" class="vh-learn-row">
                <span class="min-w-0 truncate">{{ entry.title }}</span>
                <span class="shrink-0 tabular-nums text-dimmed">{{ entry.minutes }} min</span>
              </NuxtLink>
            </li>
          </ul>
        </section>
      </div>
      <div v-else class="py-12 text-center">
        <p class="text-highlighted">No quickstart matches “{{ search }}”.</p>
        <p class="mt-1 text-sm text-muted">Try the name of a primitive, such as Queue or Blob.</p>
        <UButton class="mt-4" color="neutral" variant="outline" label="Clear search" @click="search = ''" />
      </div>
    </section>

    <!-- Coding agents write most ViteHub apps, so they get their own way in. -->
    <section class="vh-learn-agents" aria-labelledby="learn-agents">
      <div class="min-w-0 flex-1">
        <h2 id="learn-agents" class="text-base font-semibold text-highlighted">Learning with a coding agent?</h2>
        <p class="mt-1 text-pretty text-sm leading-6 text-muted">Give it the ViteHub skill or the docs MCP server, so the code it writes matches these lessons.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton color="neutral" variant="outline" to="/docs/getting-started/ai-resources/agent-instructions-skills" icon="i-lucide-sparkles" label="Add the ViteHub skill" />
        <UButton color="neutral" variant="ghost" to="/docs/getting-started/ai-resources/mcp-server" icon="i-lucide-plug" label="Connect the MCP server" />
      </div>
    </section>
  </main>
</template>

<style scoped>
.vh-learn {
  width: 100%;
  max-width: 76rem;
  margin-inline: auto;
  padding: 2.5rem 1rem 5rem;
}

@media (min-width: 40rem) {
  .vh-learn {
    padding-inline: 1.5rem;
  }
}

@media (min-width: 64rem) {
  .vh-learn {
    padding: 3.5rem 2rem 6rem;
  }
}

/* The copy, then the screenshot at the full width, so its code stays readable. */
.vh-learn-hero {
  display: grid;
  gap: 3rem;
}

.vh-learn-hero-copy {
  max-width: 44rem;
}

/* The screenshot recedes into the page: a hairline and a soft, layered shadow. */
.vh-learn-shot {
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-muted);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -8px rgb(0 0 0 / 0.12), 0 24px 48px -24px rgb(0 0 0 / 0.12);
}

.vh-learn-shot img {
  width: 100%;
  height: auto;
}

.vh-learn-section {
  margin-top: 5rem;
}

.vh-learn-section-header {
  margin-bottom: 1.5rem;
}

.vh-learn-h2 {
  color: var(--ui-text-highlighted);
  font-size: 1.375rem;
  font-weight: 600;
  text-wrap: balance;
}

.vh-learn-lead {
  max-width: 42rem;
  margin-top: 0.375rem;
  color: var(--ui-text-muted);
  font-size: 0.9375rem;
  line-height: 1.6;
  text-wrap: pretty;
}

.vh-learn-card {
  display: flex;
  height: 100%;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg);
  padding: 1.5rem;
  transition: border-color 150ms, background-color 150ms;
}

.vh-learn-card--wide {
  flex-direction: row;
  align-items: flex-start;
  gap: 1.25rem;
}

@media (hover: hover) {
  .vh-learn-card:hover {
    border-color: var(--ui-border-accented);
    background: var(--ui-bg-muted);
  }
}

.vh-learn-card:focus-visible,
.vh-learn-tile:focus-visible,
.vh-learn-row:focus-visible {
  outline: 2px solid var(--ui-border-inverted);
  outline-offset: 2px;
}

.vh-learn-index {
  display: inline-grid;
  width: 1.75rem;
  height: 1.75rem;
  place-items: center;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.vh-learn-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  color: var(--ui-text-dimmed);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

.vh-learn-cta {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 1rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
}

.vh-learn-tile {
  position: relative;
  display: grid;
  gap: 0.25rem;
  height: 100%;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  padding: 0.875rem 2.5rem 0.875rem 1rem;
  transition: border-color 150ms, background-color 150ms;
}

.vh-learn-tile-icon {
  position: absolute;
  top: 0.875rem;
  right: 0.875rem;
  width: 1rem;
  height: 1rem;
  color: var(--ui-text-dimmed);
}

@media (hover: hover) {
  .vh-learn-tile:hover {
    border-color: var(--ui-border-accented);
    background: var(--ui-bg-muted);
  }

  .vh-learn-tile:hover .vh-learn-tile-icon {
    color: var(--ui-text-highlighted);
  }
}

.vh-learn-groups {
  display: grid;
  gap: 2rem 2.5rem;
}

@media (min-width: 40rem) {
  .vh-learn-groups {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .vh-learn-groups {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.vh-learn-group {
  border-top: 1px solid var(--ui-border);
  padding-top: 1rem;
}

.vh-learn-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-inline: -0.5rem;
  border-radius: calc(var(--ui-radius) * 0.75);
  padding: 0.375rem 0.5rem;
  color: var(--ui-text);
  font-size: 0.875rem;
}

@media (hover: hover) {
  .vh-learn-row:hover {
    background: var(--ui-bg-muted);
    color: var(--ui-text-highlighted);
  }
}

.vh-learn-agents {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1.25rem 2rem;
  margin-top: 5rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg-muted);
  padding: 1.5rem;
}
</style>
