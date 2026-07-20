<script setup lang="ts">
import { examples } from "~/data/examples";

useSeoMeta({
  title: "Examples",
  ogTitle: "Examples · ViteHub",
  description: "Projects to learn from and clone-ready templates built with ViteHub.",
});
</script>

<template>
  <main class="mx-auto w-full max-w-5xl px-4 pb-24 pt-16 sm:px-6 lg:px-8">
    <header class="max-w-3xl pb-12 sm:pb-16">
      <h1 class="text-[40px] font-semibold leading-[48px] text-highlighted">
        Examples
      </h1>
      <p class="mt-6 text-xl leading-8 text-muted">
        See ViteHub in working applications, then inspect the code behind them.
      </p>
    </header>

    <section class="border-t border-default" aria-label="ViteHub examples">
      <article
        v-for="example in examples"
        :key="example.slug"
        class="grid gap-8 border-b border-default py-10 md:grid-cols-[minmax(0,1fr)_12rem] md:items-center"
      >
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <UBadge color="neutral" variant="soft">
              {{
                example.kind === "template"
                  ? "Template"
                  : example.status === "published" ? "Project" : "Project candidate"
              }}
            </UBadge>
            <UBadge v-if="example.status === 'pending'" color="warning" variant="soft">
              Publication pending
            </UBadge>
          </div>
          <h2 class="mt-4 text-3xl font-semibold text-highlighted">
            {{ example.name }}
          </h2>
          <p class="mt-3 max-w-2xl text-lg leading-8 text-muted">
            {{ example.description }}
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <UBadge
              v-for="primitive in example.builtWith"
              :key="primitive"
              color="neutral"
              variant="outline"
            >
              {{ primitive }}
            </UBadge>
          </div>
        </div>

        <aside class="flex flex-col gap-3 md:border-s md:border-default md:ps-6">
          <p v-if="example.status === 'pending'" class="text-sm leading-6 text-muted">
            {{ example.publicationNote }}
          </p>
          <UButton
            v-if="example.status === 'published'"
            :to="example.action.to"
            target="_blank"
            :label="example.action.label"
            :icon="example.kind === 'project' ? 'i-simple-icons-github' : 'i-lucide-copy'"
            color="neutral"
            variant="outline"
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
