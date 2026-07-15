<script setup lang="ts">
import { examples } from "~/data/examples";

useSeoMeta({
  title: "Examples",
  ogTitle: "Examples · ViteHub",
  description: "Projects to learn from and clone-ready templates built with ViteHub.",
});
</script>

<template>
  <main class="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 sm:px-6 lg:px-8">
    <header class="max-w-3xl border-b border-default pb-10">
      <h1 class="text-[40px] font-semibold leading-[48px] text-highlighted">
        Examples
      </h1>
      <p class="mt-6 text-xl leading-8 text-muted">
        Learn from applications built with ViteHub, or start from a template deliberately prepared for reuse.
      </p>
    </header>

    <section class="grid border-b border-default md:grid-cols-2" aria-label="Catalog entry types">
      <div class="border-default py-6 md:border-e md:pe-8">
        <div class="flex items-center gap-2 text-sm font-medium text-highlighted">
          <UIcon name="i-lucide-code-xml" class="size-4" />
          Project
        </div>
        <p class="mt-2 leading-7 text-muted">
          Open-source code you can inspect and learn from. Projects link to their source.
        </p>
      </div>
      <div class="border-t border-default py-6 md:border-t-0 md:ps-8">
        <div class="flex items-center gap-2 text-sm font-medium text-highlighted">
          <UIcon name="i-lucide-copy" class="size-4" />
          Template
        </div>
        <p class="mt-2 leading-7 text-muted">
          Clone-ready code with a clear start path. Templates provide a direct use action.
        </p>
      </div>
    </section>

    <section class="mt-12" aria-labelledby="catalog-heading">
      <div class="flex items-end justify-between gap-4 border-b border-default pb-4">
        <div>
          <p class="text-sm font-medium uppercase tracking-[0.14em] text-muted">
            Catalog
          </p>
          <h2 id="catalog-heading" class="mt-2 text-2xl font-semibold text-highlighted">
            Built with ViteHub
          </h2>
        </div>
        <span class="font-mono text-sm text-muted">{{ examples.length.toString().padStart(2, "0") }}</span>
      </div>

      <article
        v-for="example in examples"
        :key="example.slug"
        class="grid gap-8 border-b border-default py-8 lg:grid-cols-[minmax(0,1fr)_18rem]"
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
          <h3 class="mt-4 text-3xl font-semibold text-highlighted">
            {{ example.name }}
          </h3>
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

        <aside class="flex flex-col justify-between gap-5 border-s border-default ps-5">
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
