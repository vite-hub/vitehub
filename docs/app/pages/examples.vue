<script setup lang="ts">
import { examples } from "~/data/examples";

useSeoMeta({
  title: "Projects and templates",
  ogTitle: "Projects and templates · ViteHub",
  description: "Explore open source ViteHub projects to read real application code, or start your own app from a published GitHub template.",
});

const catalogs = [
  {
    kind: "project",
    title: "Projects",
    to: "/projects",
    icon: "i-ph-git-branch-light",
    label: "Browse projects",
    description: "Complete open source applications. Read the source to see how the packages fit together in a real app.",
  },
  {
    kind: "template",
    title: "Templates",
    to: "/templates",
    icon: "i-ph-squares-four-light",
    label: "Browse templates",
    description: "Working apps that you copy into your own GitHub account. Each template names the file to open first.",
  },
] as const;

const publishedByKind = (kind: "project" | "template") =>
  examples.filter((example) => example.kind === kind && example.status === "published");
</script>

<template>
  <main class="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
    <header class="max-w-2xl">
      <h1 class="text-balance text-3xl font-semibold text-highlighted sm:text-4xl">Projects and templates</h1>
      <p class="mt-3 text-pretty text-base leading-7 text-muted">
        Projects show complete applications. Templates give you a clean starting point. Browse each catalog to choose the right kind of source.
      </p>
    </header>

    <div class="mt-10 grid gap-px border border-default bg-[var(--ui-border)] sm:grid-cols-2">
      <section v-for="catalog in catalogs" :key="catalog.kind" class="flex flex-col bg-default p-6">
        <UIcon :name="catalog.icon" class="size-6 text-muted" />
        <h2 class="mt-4 text-xl font-semibold text-highlighted">{{ catalog.title }}</h2>
        <p class="mt-2 text-sm leading-6 text-muted">{{ catalog.description }}</p>

        <ul class="mt-6 flex-1 space-y-4">
          <li v-for="example in publishedByKind(catalog.kind)" :key="example.slug">
            <h3 class="text-sm font-semibold text-highlighted">{{ example.name }}</h3>
            <p class="mt-1 text-sm leading-6 text-muted">{{ example.description }}</p>
            <p class="mt-1 text-xs leading-5 text-dimmed">Built with {{ example.builtWith.join(", ") }}</p>
          </li>
        </ul>

        <NuxtLink :to="catalog.to" class="mt-6 inline-flex text-sm font-medium text-highlighted underline underline-offset-4">
          {{ catalog.label }}
        </NuxtLink>
      </section>
    </div>
  </main>
</template>
