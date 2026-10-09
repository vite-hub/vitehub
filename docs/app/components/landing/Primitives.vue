<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { landingPrimitives } from "./content";

const grid = useTemplateRef<HTMLElement>("grid");
const visible = ref(false);

// Loops run only while the grid is on screen.
useIntersectionObserver(grid, ([entry]) => {
  visible.value = entry?.isIntersecting ?? false;
});

// Spread start points across the loop so neighboring tiles do not move together.
function offset(index: number) {
  return (index * 0.37) % 1;
}

function primitiveKind(id: string) {
  if (id === "agent") return "Agent runtime";
  if (id === "ui") return "UI components";
  return "Server Primitive";
}
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div
        class="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,0.6fr)] lg:items-end lg:gap-20"
      >
        <div>
          <p class="mb-5 font-mono text-xs uppercase tracking-[0.14em] text-dimmed">Build with ViteHub</p>
          <h1
            class="max-w-[16ch] text-3xl/9 font-semibold tracking-[-0.03em] text-highlighted text-balance sm:text-4xl/10"
          >
            Server pieces, Agents, and UI in one place.
          </h1>
        </div>
        <div class="max-w-[40ch] lg:justify-self-end">
          <p class="text-base/7 text-muted">
            Pick the building block that matches the work. Call server APIs from routes and jobs,
            add Agent runtimes when you need them, and use UI components to inspect what is running.
          </p>
          <NuxtLink
            to="/docs/getting-started/server-primitives"
            class="group mt-3 mr-5 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Explore Server Primitives
            <UIcon
              name="i-lucide-arrow-right"
              class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>
      </div>

      <ul
        ref="grid"
        class="mt-12 grid grid-cols-2 gap-px border border-default bg-[var(--ui-border)] sm:grid-cols-4 lg:mt-16 lg:grid-cols-5"
        role="list"
      >
        <!-- The Agent tile spans two cells, so the catalog still reads as a dense package grid. -->
        <li
          v-for="(primitive, index) in landingPrimitives"
          :key="primitive.id"
          class="min-w-0 bg-default"
          :class="{ 'col-span-2': primitive.id === 'agent' }"
        >
          <NuxtLink
            :to="primitive.to"
            class="primitive-tile group flex h-full min-h-36 flex-col gap-4 p-5 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:min-h-40 sm:p-6"
          >
            <div
              class="primitive-illustration h-10 w-full text-muted transition-colors duration-200 group-hover:text-highlighted"
            >
              <LandingPrimitiveMotion :name="primitive.id" :play="visible" :offset="offset(index)" />
            </div>
            <div>
              <p class="text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-dimmed">
                {{ primitiveKind(primitive.id) }}
              </p>
              <h2 class="text-sm font-medium text-highlighted">
                {{ primitive.name }}
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                {{ primitive.description }}
              </p>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* Scenes with overlapping shapes fill them with the tile background. */
.primitive-tile {
  --tile-bg: var(--ui-bg);
  background: var(--tile-bg);
  transition: background-color 200ms ease;
}

.primitive-illustration {
  opacity: 0.72;
  transition: opacity 200ms ease, color 200ms ease;
}

.primitive-tile:focus-visible {
  --tile-bg: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
}

.primitive-tile:focus-visible .primitive-illustration {
  opacity: 1;
}

@media (hover: hover) and (pointer: fine) {
  .primitive-tile:hover {
    --tile-bg: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
  }

  .primitive-tile:hover .primitive-illustration {
    opacity: 1;
  }

  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .primitive-tile,
  .primitive-illustration {
    transition: none;
  }
}
</style>
