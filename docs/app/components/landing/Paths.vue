<script setup lang="ts">
import { landingLanes } from "./content"
</script>

<template>
  <section id="start" class="border-b border-default bg-muted/20">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-28">
      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16">
        <h2 class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14">
          Start where you need.
        </h2>
        <p class="max-w-[32ch] text-lg/8 text-muted lg:justify-self-end">
          Both paths share one server layer.
        </p>
      </div>

      <div class="mt-12 grid border border-default bg-default lg:mt-16 lg:grid-cols-2">
        <NuxtLink
          v-for="(lane, index) in landingLanes"
          :key="lane.id"
          :to="lane.tutorialPath"
          class="group flex min-w-0 flex-col focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          :class="index === 1 ? 'border-t border-default lg:border-t-0 lg:border-l' : ''"
        >
          <div class="aspect-[16/9] overflow-hidden border-b border-default bg-default">
            <img
              :src="lane.image"
              alt=""
              width="1672"
              height="941"
              loading="lazy"
              decoding="async"
              class="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.015] dark:invert motion-reduce:transform-none motion-reduce:transition-none"
            >
          </div>

          <div class="flex flex-1 flex-col p-6 sm:p-8 lg:p-10">
            <h3 class="text-3xl/9 font-semibold tracking-[-0.03em] text-highlighted sm:text-4xl/10">
              {{ lane.name }}
            </h3>
            <p class="mt-4 max-w-[46ch] text-base/7 text-muted sm:text-lg/7">
              {{ lane.description }}
            </p>
            <span class="mt-8 inline-flex min-h-12 items-center gap-2 self-start border-b border-highlighted font-medium text-highlighted lg:mt-10">
              {{ lane.action }}
              <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none" aria-hidden="true" />
            </span>
          </div>
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
