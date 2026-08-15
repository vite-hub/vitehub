<script setup lang="ts">
import { MotionConfig } from "motion-v"
import AgentPlayground from "./AgentPlayground.vue"
</script>

<template>
  <section class="border-b border-default bg-default">
    <div
      class="mx-auto grid min-h-[calc(100svh-var(--ui-header-height))] max-w-[90rem] items-center gap-10 px-4 py-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(23rem,0.76fr)_minmax(0,1.24fr)] lg:gap-14 lg:px-12 lg:py-16"
    >
      <div class="vh-landing-reveal min-w-0">
        <h1 class="vh-hero-title max-w-[9ch] font-semibold text-highlighted text-balance">
          Any agent, anywhere.
        </h1>
        <p class="mt-7 max-w-[44ch] text-lg/8 text-muted text-pretty sm:text-xl/8">
          Bring any model or coding provider, compose your own Capabilities around a persistent Workspace,
          and deploy the same Agent to any host.
        </p>

        <LandingInstallCommand class="mt-9" />

        <div class="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <NuxtLink
            to="/docs/getting-started/first-agent"
            class="hero-cta inline-flex min-h-10 items-center gap-1.5 font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Start building
            <UIcon
              name="i-lucide-arrow-right"
              class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
          <NuxtLink
            to="/docs"
            class="inline-flex min-h-10 items-center text-muted transition-colors hover:text-default focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Read the docs
          </NuxtLink>
        </div>
      </div>

      <ClientOnly>
        <MotionConfig reduced-motion="user">
          <AgentPlayground class="vh-landing-reveal vh-landing-reveal-delay min-w-0" />
        </MotionConfig>
        <template #fallback>
          <div class="min-h-[32rem]" />
        </template>
      </ClientOnly>
    </div>
  </section>
</template>

<style scoped>
.vh-hero-title {
  font-size: clamp(3.75rem, 5.8vw, 6.25rem);
  letter-spacing: -0.06em;
  line-height: 0.92;
}

@media (hover: hover) and (pointer: fine) {
  .hero-cta:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}
</style>
