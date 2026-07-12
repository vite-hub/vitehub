<script setup lang="ts">
import { landingPaths } from "./content";
</script>

<template>
  <section id="start" class="border-b border-default bg-muted/20">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div
        class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16"
      >
        <h2
          class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14"
        >
          Start with an Agent.
        </h2>
        <p class="max-w-[36ch] text-lg/8 text-muted lg:justify-self-end">
          Use Server Primitives directly when ordinary server code is all you need.
        </p>
      </div>

      <div
        class="mt-12 grid border border-default bg-default lg:mt-16 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]"
      >
        <article
          v-for="(path, index) in landingPaths"
          :key="path.id"
          class="flex min-w-0 flex-col p-5 sm:p-7 lg:p-9"
          :class="index === 1 ? 'border-t border-default lg:border-t-0 lg:border-l' : ''"
        >
          <div class="flex flex-1 flex-col">
            <h3 class="text-3xl/9 font-semibold tracking-[-0.03em] text-highlighted sm:text-4xl/10">
              {{ path.name }}
            </h3>
            <p class="mt-4 max-w-[46ch] text-base/7 text-muted sm:text-lg/7">
              {{ path.description }}
            </p>

            <NuxtLink
              :to="path.tutorialPath"
              class="group mt-7 inline-flex min-h-10 items-center gap-2 self-start border-b border-highlighted font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            >
              {{ path.action }}
              <UIcon
                name="i-lucide-arrow-right"
                class="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </NuxtLink>
          </div>

          <div class="mt-9 overflow-hidden border border-default bg-muted/20">
            <div
              class="flex min-h-10 items-center gap-2 border-b border-default bg-muted/40 px-3 font-mono text-xs text-muted"
            >
              <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ path.codeLabel }}</span>
            </div>
            <pre
              class="min-h-[15rem] overflow-x-auto p-4 font-mono text-xs/6 text-default sm:text-[0.8125rem]/6"
            ><code>{{ path.code }}</code></pre>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
