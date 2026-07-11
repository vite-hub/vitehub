<script setup lang="ts">
import { landingLanes } from "./content"
</script>

<template>
  <section class="bg-inverted text-inverted">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(24rem,0.8fr)] lg:items-end lg:gap-16">
        <div>
          <p class="font-mono text-xs/5 font-medium tracking-[0.16em] text-inverted/60 uppercase">
            Your move / Pick a path
          </p>
          <h2 class="mt-5 max-w-[14ch] text-4xl/10 font-semibold tracking-[-0.04em] text-inverted text-balance sm:text-5xl/12 lg:text-6xl/14">
            Your first decision is not a provider.
          </h2>
        </div>

        <div>
          <p class="max-w-[50ch] text-lg/8 text-inverted/70 text-pretty">
            Choose the smallest ViteHub surface that solves today's problem. Both paths keep runtime assumptions and provider output inspectable.
          </p>
          <div class="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <NuxtLink
              v-for="lane in landingLanes"
              :key="lane.id"
              :to="lane.tutorialPath"
              class="inline-flex min-h-12 items-center justify-center gap-2 border border-inverted bg-default px-4 py-2.5 text-base/6 font-medium text-default transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverted sm:text-sm/6"
            >
              Start with {{ lane.name }}
              <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
            </NuxtLink>
          </div>
        </div>
      </div>

      <div class="mt-14 grid border border-inverted/25 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] md:items-center">
        <p class="border-b border-inverted/25 px-4 py-4 font-mono text-xs/5 tracking-[0.12em] text-inverted/60 uppercase md:border-r md:border-b-0 sm:px-5">
          Building with a coding agent?
        </p>
        <code class="min-w-0 overflow-x-auto border-b border-inverted/25 px-4 py-4 font-mono text-base/6 whitespace-nowrap text-inverted md:border-b-0 sm:px-5 sm:text-sm/6">npx skills add https://vitehub.dev</code>
        <NuxtLink
          to="/docs/ai-resources/agent-instructions-skills"
          class="inline-flex min-h-12 items-center justify-between gap-3 px-4 py-3 font-medium text-inverted hover:bg-inverted/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-inverted sm:px-5"
        >
          Install the ViteHub skill
          <UIcon name="i-lucide-arrow-up-right" class="size-4 shrink-0" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
