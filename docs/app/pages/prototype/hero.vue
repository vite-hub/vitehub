<script setup lang="ts">
import { MotionConfig } from "motion-v"
import AgentPlayground from "../../components/prototype/hero/AgentPlayground.vue"

useSeo({
  title: "Hero Prototype",
  description: "Interactive ViteHub Agent Definition hero prototype.",
})

useHead({
  meta: [{ name: "robots", content: "noindex, nofollow" }],
})
</script>

<template>
  <UMain class="bg-default text-default">
    <section class="border-b border-default bg-default">
      <div
        class="mx-auto grid min-h-[calc(100svh-var(--ui-header-height))] max-w-[90rem] items-center gap-10 px-4 py-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(23rem,0.76fr)_minmax(0,1.24fr)] lg:gap-14 lg:px-12 lg:py-16"
      >
        <div class="min-w-0">
          <h1 class="prototype-title max-w-[9ch] font-semibold text-highlighted text-balance">
            Any agent, anywhere.
          </h1>
          <p class="mt-7 max-w-[44ch] text-lg/8 text-muted text-pretty sm:text-xl/8">
            Bring any model or harness, compose your own Capabilities around a persistent Workspace,
            and deploy the same Agent to any host.
          </p>

          <LandingInstallCommand class="mt-9" />

          <div class="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <NuxtLink
              to="/docs/getting-started/first-agent"
              class="group inline-flex min-h-10 items-center gap-1.5 font-medium text-highlighted"
            >
              Start building
              <UIcon name="i-lucide-arrow-right" class="size-4 transition-transform duration-200" />
            </NuxtLink>
            <span class="text-muted">Vite-native · host-portable</span>
          </div>
        </div>

        <ClientOnly>
          <MotionConfig reduced-motion="user">
            <AgentPlayground class="min-w-0" />
          </MotionConfig>
          <template #fallback>
            <div class="min-h-[32rem]" />
          </template>
        </ClientOnly>
      </div>
    </section>
  </UMain>
</template>

<style scoped>
.prototype-title {
  font-size: clamp(3.75rem, 5.8vw, 6.25rem);
  letter-spacing: -0.06em;
  line-height: 0.92;
}

@media (hover: hover) and (pointer: fine) {
  .group:hover :deep(svg) {
    transform: translateX(0.25rem);
  }
}
</style>
