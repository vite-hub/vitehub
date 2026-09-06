<script setup lang="ts">
import { examples } from "~/data/examples";

useSeoMeta({
  title: "Examples",
  ogTitle: "Examples · ViteHub",
  description: "Open projects built with ViteHub, ready to inspect and run.",
});
</script>

<template>
  <main class="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 sm:px-6 sm:pt-20 lg:px-8">
    <header class="max-w-3xl pb-12 sm:pb-16">
      <p class="font-mono text-xs font-medium uppercase tracking-[0.18em] text-primary">
        Built with ViteHub
      </p>
      <h1 class="mt-4 text-4xl font-semibold leading-tight text-highlighted sm:text-5xl">
        Examples
      </h1>
      <p class="mt-5 max-w-2xl text-lg leading-8 text-muted sm:text-xl">
        Explore working applications, see which ViteHub pieces they compose, and inspect the code
        behind them.
      </p>
    </header>

    <section
      class="grid gap-px overflow-hidden rounded-xl border border-default bg-[var(--ui-border)] sm:grid-cols-2"
      aria-label="ViteHub examples"
    >
      <article
        v-for="(example, index) in examples"
        :key="example.slug"
        class="flex min-h-[28rem] flex-col bg-default p-6 sm:p-8"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge color="neutral" variant="soft">
              {{ example.kind === "template" ? "Template" : "Project" }}
            </UBadge>
            <UBadge :color="example.status === 'published' ? 'success' : 'warning'" variant="soft">
              {{ example.status === "published" ? "Available" : "Upcoming" }}
            </UBadge>
          </div>
          <span class="font-mono text-xs text-dimmed">
            {{ String(index + 1).padStart(2, "0") }}
          </span>
        </div>

        <h2 class="mt-8 text-3xl font-semibold tracking-tight text-highlighted">
          {{ example.name }}
        </h2>
        <p class="mt-4 text-base leading-7 text-muted">
          {{ example.description }}
        </p>

        <div class="mt-7 flex flex-wrap gap-2">
          <UBadge
            v-for="primitive in example.builtWith"
            :key="primitive"
            color="neutral"
            variant="outline"
          >
            {{ primitive }}
          </UBadge>
        </div>

        <aside class="mt-auto flex flex-col gap-3 border-t border-default pt-6">
          <p v-if="example.status === 'pending'" class="text-sm leading-6 text-muted">
            {{ example.publicationNote }}
          </p>
          <UButton
            v-if="example.status === 'published'"
            :to="example.action.to"
            target="_blank"
            :label="example.action.label"
            :icon="example.kind === 'project' ? 'i-simple-icons-github' : 'i-lucide-copy'"
            trailing-icon="i-lucide-arrow-up-right"
            color="neutral"
            variant="soft"
            block
          />
          <UButton
            v-else
            :label="example.action.label"
            icon="i-lucide-lock-keyhole"
            color="neutral"
            variant="outline"
            disabled
            block
          />
        </aside>
      </article>
    </section>
  </main>
</template>
