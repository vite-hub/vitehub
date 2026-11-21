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
          <UButton :to="first.to" trailing-icon="i-lucide-arrow-right" label="Start the KV tutorial" />
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
      <UPageGrid as="ol">
        <UPageCard
          v-for="(entry, index) in catalog.browser"
          :key="entry.to"
          as="li"
          :to="entry.to"
          :icon="entry.icon"
          :title="entry.title"
          :description="entry.description"
        >
          <template #footer>
            <p class="text-xs text-dimmed tabular-nums">
              Lesson {{ index + 1 }} · {{ learnMeta(entry) }} · Runs in your browser
            </p>
          </template>
        </UPageCard>
      </UPageGrid>
    </section>

    <!-- Complete projects. -->
    <section v-if="catalog.projects.length" class="vh-learn-section" aria-labelledby="learn-projects">
      <header class="vh-learn-section-header">
        <h2 id="learn-projects" class="vh-learn-h2">Build a full app</h2>
        <p class="vh-learn-lead">A complete project on your machine. Each step adds a feature and shows how to check it.</p>
      </header>
      <div class="grid gap-3">
        <UPageCard
          v-for="entry in catalog.projects"
          :key="entry.to"
          :to="entry.to"
          :icon="entry.icon"
          :title="entry.title"
          :description="entry.description"
        >
          <template #footer>
            <p class="text-xs text-dimmed tabular-nums">
              {{ entry.product }} · {{ learnMeta(entry) }} · On your machine
            </p>
          </template>
        </UPageCard>
      </div>
    </section>

    <!-- Playground templates: one primitive each, running at once. -->
    <section class="vh-learn-section" aria-labelledby="learn-playground">
      <header class="vh-learn-section-header">
        <h2 id="learn-playground" class="vh-learn-h2">Try a primitive in the playground</h2>
        <p class="vh-learn-lead">Open a small app that uses one primitive, change the code, and see the result. No lesson, no setup.</p>
      </header>
      <UPageGrid as="ul">
        <UPageCard
          v-for="template in templates"
          :key="template.id"
          as="li"
          :to="template.id === templates[0]?.id ? '/playground' : `/playground?template=${template.id}`"
          :title="template.label"
          :description="template.description"
        />
      </UPageGrid>
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
      <UEmpty
        v-else
        icon="i-lucide-search"
        :title="`No quickstart matches “${search}”`"
        description="Try the name of a primitive, such as Queue or Blob."
        :actions="[{ label: 'Clear search', variant: 'outline', onClick: () => { search = '' } }]"
      />
    </section>

    <!-- Coding agents write most ViteHub apps, so they get their own way in. -->
    <section class="vh-learn-agents" aria-labelledby="learn-agents">
      <div class="min-w-0 flex-1">
        <h2 id="learn-agents" class="text-base font-semibold text-highlighted">Learning with a coding agent?</h2>
        <p class="mt-1 text-pretty text-sm leading-6 text-muted">Give it the ViteHub skill or the docs MCP server, so the code it writes matches these lessons.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton variant="outline" to="/docs/getting-started/ai-resources/agent-instructions-skills" icon="i-lucide-sparkles" label="Add the ViteHub skill" />
        <UButton variant="ghost" to="/docs/console/mcp" icon="i-lucide-plug" label="Connect the MCP server" />
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

/* The screenshot sits in a hairline frame, like every other framed box. */
.vh-learn-shot {
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-muted);
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
  border-radius: calc(var(--ui-radius) * 1.5);
  padding: 0.375rem 0.5rem;
  color: var(--ui-text);
  font-size: 0.875rem;
}

@media (hover: hover) {
  .vh-learn-row:hover {
    background: var(--ui-bg-elevated);
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
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-muted);
  padding: 1.5rem;
}
</style>
