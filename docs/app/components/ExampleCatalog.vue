<script setup lang="ts">
import { examples, type Example } from "~/data/examples";

type ExampleKind = "project" | "template";
type PublishedExample = Extract<Example, { status: "published" }>;
type PendingExample = Extract<Example, { status: "pending" }>;

const props = defineProps<{
  kind: ExampleKind;
  title: string;
  description: string;
}>();

const available = computed(() => examples.filter((example): example is PublishedExample =>
  example.kind === props.kind && example.status === "published",
));
const upcoming = computed(() => examples.filter((example): example is PendingExample =>
  example.kind === props.kind && example.status === "pending",
));
</script>

<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
    <header class="mb-8 max-w-2xl">
      <h1 class="text-balance text-3xl font-semibold text-highlighted sm:text-4xl">{{ title }}</h1>
      <p class="mt-3 text-pretty text-base leading-7 text-muted">{{ description }}</p>
    </header>

    <section class="grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-3" :aria-label="title">
      <article
        v-for="example in available"
        :key="example.slug"
        class="flex min-w-0 flex-col overflow-hidden rounded-lg border border-default bg-default"
      >
        <ExampleAppPreview :preview="example.preview" />
        <div class="flex flex-1 flex-col p-4 sm:p-5">
          <p class="text-xs text-muted">{{ kind === "template" ? "Starter template" : "Open source app" }}</p>
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
              :icon="kind === 'project' ? 'i-simple-icons-github' : 'i-lucide-copy'"
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

    <section v-if="upcoming.length" class="mt-12" aria-labelledby="upcoming-examples">
      <h2 id="upcoming-examples" class="text-lg font-semibold text-highlighted">In progress</h2>
      <p class="mt-1 text-sm text-muted">These {{ kind }}s are not ready to copy or run yet.</p>
      <dl class="mt-4 divide-y divide-default border-y border-default">
        <div
          v-for="example in upcoming"
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

    <section class="mt-12 border-y border-default py-7" aria-labelledby="share-example">
      <h2 id="share-example" class="text-lg font-semibold text-highlighted">Share your {{ kind }}</h2>
      <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
        Add a licensed ViteHub project or template to this catalog by opening a pull request. Include its source URL, a short description, the ViteHub packages it uses, and an honest preview.
      </p>
      <UButton
        class="mt-4"
        to="https://github.com/vite-hub/vitehub/pulls"
        target="_blank"
        rel="noopener noreferrer"
        label="Open a pull request"
        trailing-icon="i-lucide-arrow-up-right"
        color="neutral"
        variant="outline"
        size="sm"
      />
    </section>
  </main>
</template>
