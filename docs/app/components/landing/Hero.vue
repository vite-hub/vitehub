<script setup lang="ts">
import { landingLanes } from "./content"
</script>

<template>
  <section class="vh-hero relative isolate overflow-clip border-b border-default bg-default">
    <div class="vh-landing-reveal mx-auto max-w-[90rem] px-4 pt-12 pb-5 sm:px-8 sm:pt-16 lg:px-12 lg:pt-20">
      <div class="grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)] lg:items-end lg:gap-16">
        <div class="min-w-0">
          <p class="flex items-center gap-3 font-mono text-xs/5 font-medium tracking-[0.16em] text-muted uppercase">
            <span class="size-2 shrink-0 rounded-full bg-highlighted" aria-hidden="true" />
            ViteHub / Server layer for Vite
          </p>
          <h1 class="vh-hero-title mt-7 max-w-[12ch] font-semibold text-highlighted text-balance">
            Two ways in.<br>
            One server layer.
          </h1>
        </div>

        <div class="min-w-0 border-t border-default pt-6 lg:mb-2">
          <p class="max-w-[48ch] text-lg/8 text-default text-pretty sm:text-xl/8">
            ViteHub gives Vite applications the server layer they are missing. Use portable Server Primitives directly, or compose them into Agents with explicit runtime boundaries.
          </p>
          <p class="mt-6 max-w-[52ch] text-base/7 text-muted text-pretty">
            Agents may compose Server Primitives. Server Primitives work independently.
          </p>
        </div>
      </div>
    </div>

    <div class="vh-landing-reveal vh-landing-reveal-delay mx-auto grid max-w-[90rem] border-x border-t border-default md:grid-cols-2">
      <NuxtLink
        v-for="(lane, index) in landingLanes"
        :key="lane.id"
        :to="lane.tutorialPath"
        class="vh-lane group relative flex min-w-0 flex-col overflow-hidden px-4 py-8 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:px-8 sm:py-10 lg:min-h-[31rem] lg:px-12 lg:py-12"
        :class="index === 1 ? 'border-t border-default md:border-t-0 md:border-l' : ''"
      >
        <div class="vh-lane-rail" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div class="relative z-10 flex items-center justify-between gap-4">
          <p class="font-mono text-xs/5 font-medium tracking-[0.16em] text-muted uppercase">
            {{ lane.number }} / {{ lane.mode }}
          </p>
          <span class="rounded-full border border-default bg-default px-2.5 py-1 font-mono text-[0.6875rem]/4 text-muted">
            Pick this path
          </span>
        </div>

        <div class="relative z-10 mt-14 max-w-xl lg:mt-auto">
          <h2 class="text-4xl/10 font-semibold tracking-[-0.035em] text-highlighted sm:text-5xl/12">
            {{ lane.name }}
          </h2>
          <p class="mt-5 max-w-[52ch] text-base/7 text-muted text-pretty sm:text-lg/7">
            {{ lane.summary }}
          </p>

          <ul class="mt-7 grid gap-2.5 text-base/6 text-default sm:text-sm/6" role="list">
            <li v-for="outcome in lane.outcomes" :key="outcome" class="flex items-start gap-3">
              <span class="mt-[0.6rem] h-px w-5 shrink-0 bg-highlighted" aria-hidden="true" />
              <span>{{ outcome }}</span>
            </li>
          </ul>

          <span class="mt-8 inline-flex min-h-12 items-center gap-2 border-b border-highlighted font-medium text-highlighted">
            {{ lane.action }}
            <UIcon name="i-lucide-arrow-up-right" class="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-1 group-hover:-translate-y-1 motion-reduce:transform-none motion-reduce:transition-none" aria-hidden="true" />
          </span>
        </div>
      </NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.vh-hero::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image:
    linear-gradient(90deg, color-mix(in srgb, var(--ui-border) 48%, transparent) 1px, transparent 1px),
    linear-gradient(180deg, color-mix(in srgb, var(--ui-border) 34%, transparent) 1px, transparent 1px);
  background-position: center top;
  background-size: clamp(3rem, 5vw, 5rem) clamp(3rem, 5vw, 5rem);
  content: "";
  mask-image: linear-gradient(180deg, black, transparent 62%);
  opacity: 0.52;
  pointer-events: none;
}

.vh-hero-title {
  font-size: clamp(3rem, 8.7vw, 8.4rem);
  letter-spacing: -0.065em;
  line-height: 0.9;
}

.vh-lane {
  background: color-mix(in srgb, var(--ui-bg) 94%, var(--ui-bg-muted));
}

.vh-lane:nth-child(2) {
  background: color-mix(in srgb, var(--ui-bg-muted) 72%, var(--ui-bg));
}

.vh-lane::after {
  position: absolute;
  inset: 0;
  background: var(--ui-bg-muted);
  content: "";
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.vh-lane:hover::after {
  opacity: 0.42;
}

.vh-lane-rail {
  position: absolute;
  top: 5.5rem;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  color: var(--ui-text-dimmed);
  opacity: 0.48;
}

.vh-lane-rail::before {
  position: absolute;
  right: 0;
  left: 0;
  height: 1px;
  background: currentColor;
  content: "";
}

.vh-lane-rail span {
  position: relative;
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: currentColor;
}

@media (max-width: 47.999rem) {
  .vh-lane-rail {
    top: 5rem;
  }
}
</style>
