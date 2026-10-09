<script setup lang="ts">
import { examples } from "~/data/examples";

const availableExamples = examples.filter((example) => example.status === "published");
const upcomingExamples = examples.filter((example) => example.status === "pending");

useSeoMeta({
  title: "Examples",
  ogTitle: "Examples · ViteHub",
  description: "Explore ViteHub apps, inspect their source, and start from a working template.",
});
</script>

<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
    <header class="mb-8 max-w-2xl">
      <h1 class="text-balance text-3xl font-semibold text-highlighted sm:text-4xl">Examples</h1>
      <p class="mt-3 text-pretty text-base leading-7 text-muted">
        See what you can build with ViteHub. Open an app, read its source, or copy a template and
        make it your own.
      </p>
    </header>

    <section
      class="grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-3"
      aria-label="Available examples"
    >
      <article
        v-for="example in availableExamples"
        :key="example.slug"
        class="flex min-w-0 flex-col overflow-hidden rounded-lg border border-default bg-default"
      >
        <ExampleAppPreview :preview="example.preview" />
        <div class="flex flex-1 flex-col p-4 sm:p-5">
          <p class="text-xs text-muted">
            {{ example.kind === "template" ? "Starter template" : "Open source app" }}
          </p>
          <h2 class="mt-1 text-xl font-semibold text-highlighted">{{ example.name }}</h2>
          <p class="mt-3 text-pretty text-sm leading-6 text-muted">{{ example.description }}</p>
          <dl class="mt-4 text-xs leading-5">
            <dt class="font-medium text-highlighted">Built with</dt>
            <dd class="mt-1 text-muted">{{ example.builtWith.join(", ") }}</dd>
            <template v-if="example.kind === 'template'">
              <dt class="mt-3 font-medium text-highlighted">Start in</dt>
              <dd class="mt-1 break-all font-mono text-muted">{{ example.startPath }}</dd>
            </template>
          </dl>
          <div class="mt-auto flex flex-wrap gap-2 pt-5">
            <UButton
              :to="example.action.to"
              target="_blank"
              rel="noopener noreferrer"
              :label="example.action.label"
              :icon="example.kind === 'project' ? 'i-simple-icons-github' : 'i-lucide-copy'"
              color="neutral"
              variant="outline"
              size="sm"
            />
            <UButton
              v-if="example.kind === 'template'"
              :to="example.action.to.replace(/\/generate$/, '')"
              target="_blank"
              rel="noopener noreferrer"
              label="View source"
              color="neutral"
              variant="ghost"
              size="sm"
            />
            <UButton
              v-if="example.website"
              :to="example.website"
              target="_blank"
              rel="noopener noreferrer"
              label="Open app"
              trailing-icon="i-lucide-arrow-up-right"
              color="neutral"
              variant="ghost"
              size="sm"
            />
          </div>
        </div>
      </article>
    </section>

    <section v-if="upcomingExamples.length" class="mt-12" aria-labelledby="upcoming-examples">
      <h2 id="upcoming-examples" class="text-lg font-semibold text-highlighted">In progress</h2>
      <p class="mt-1 text-sm text-muted">These projects are not ready to copy or run yet.</p>
      <dl class="mt-4 divide-y divide-default border-y border-default">
        <div
          v-for="example in upcomingExamples"
          :key="example.slug"
          class="grid gap-2 py-4 sm:grid-cols-4 sm:gap-6"
        >
          <dt class="text-sm font-medium text-highlighted">{{ example.name }}</dt>
          <dd class="min-w-0 text-sm leading-6 sm:col-span-3">
            <p class="text-muted">{{ example.description }}</p>
            <p class="mt-1 text-xs text-dimmed">{{ example.publicationNote }}</p>
          </dd>
        </div>
      </dl>
    </section>
  </main>
</template>
