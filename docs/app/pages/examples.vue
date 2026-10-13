<script setup lang="ts">
useSeoMeta({
  title: "Projects and templates",
  ogTitle: "Projects and templates · ViteHub",
  description: "Explore open source ViteHub projects and starter templates.",
});
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
      <NuxtLink to="/projects" class="group bg-default p-6 transition-colors hover:bg-muted/30">
        <UIcon name="i-ph-git-branch-light" class="size-6 text-muted group-hover:text-highlighted" />
        <h2 class="mt-4 text-xl font-semibold text-highlighted">Projects</h2>
        <p class="mt-2 text-sm leading-6 text-muted">Read source code and inspect running applications.</p>
        <span class="mt-6 inline-flex text-sm font-medium text-highlighted underline underline-offset-4">Browse projects</span>
      </NuxtLink>
      <NuxtLink to="/templates" class="group bg-default p-6 transition-colors hover:bg-muted/30">
        <UIcon name="i-ph-squares-four-light" class="size-6 text-muted group-hover:text-highlighted" />
        <h2 class="mt-4 text-xl font-semibold text-highlighted">Templates</h2>
        <p class="mt-2 text-sm leading-6 text-muted">Copy a working app and make it yours.</p>
        <span class="mt-6 inline-flex text-sm font-medium text-highlighted underline underline-offset-4">Browse templates</span>
      </NuxtLink>
    </div>
  </main>
</template>
