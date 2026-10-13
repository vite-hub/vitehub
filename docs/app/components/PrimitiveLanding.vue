<script setup lang="ts">
import type { PrimitiveLanding } from "~/data/primitive-landings/types";
import { primitiveLandings } from "~/data/primitive-landings";

const props = defineProps<{ landing: PrimitiveLanding }>();
const framework = useState<"vite" | "nitro" | "nuxt">("primitive-framework", () => "vite");
const selectorOpen = ref(false);
const accentClasses = {
  primary: "text-primary",
  info: "text-info",
  warning: "text-warning",
  secondary: "text-secondary",
};
const primitiveOptions = Object.values(primitiveLandings);
useSeoMeta({
  title: `ViteHub ${props.landing.name}`,
  ogTitle: `ViteHub ${props.landing.name}`,
  description: props.landing.description,
  ogDescription: props.landing.description,
});
</script>

<template>
  <main class="bg-default text-default">
    <header class="border-b border-default">
      <div class="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-8 lg:px-12">
        <NuxtLink to="/" class="text-lg font-semibold tracking-[-0.04em] text-highlighted">ViteHub</NuxtLink>
        <UPopover v-model:open="selectorOpen" :ui="{ content: 'w-[min(36rem,calc(100vw-2rem))] p-2' }">
          <UButton :label="landing.name" trailing-icon="i-lucide-chevron-down" color="neutral" variant="ghost" />
          <template #content>
            <div class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-default bg-default sm:grid-cols-3">
              <NuxtLink
                v-for="primitive in primitiveOptions"
                :key="primitive.slug"
                :to="primitive.docsTo"
                class="bg-elevated p-3 transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-accented focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary"
                @click="selectorOpen = false"
              >
                <span class="block text-sm font-medium text-highlighted">{{ primitive.name }}</span>
                <span class="mt-1 block text-xs text-muted">{{ primitive.description }}</span>
              </NuxtLink>
            </div>
          </template>
        </UPopover>
      </div>
    </header>

    <section
      class="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-8 sm:py-20 lg:items-center lg:gap-16 lg:px-12 lg:py-24"
      :class="{ 'lg:grid-cols-[.8fr_1.2fr]': landing.variants.length > 0 }"
    >
      <div>
        <p class="font-mono text-xs uppercase tracking-[0.18em]" :class="accentClasses[landing.accent]">{{ landing.eyebrow }}</p>
        <h1 class="mt-5 max-w-xl text-5xl font-semibold leading-[.95] tracking-[-0.07em] text-highlighted text-balance sm:text-6xl">ViteHub {{ landing.name }}</h1>
        <p class="mt-6 max-w-lg text-lg leading-8 text-muted text-pretty">{{ landing.description }}</p>
        <div class="mt-7 flex flex-wrap gap-2 text-xs text-muted">
          <span v-for="support in landing.supported" :key="support" class="rounded-md border border-default px-2.5 py-1.5">{{ support }}</span>
        </div>
        <UButton class="mt-8" :to="landing.docsTo" label="Read the guide" trailing-icon="i-lucide-arrow-up-right" :color="landing.accent" />
      </div>
      <PrimitiveProjectGroup v-if="landing.variants.length" v-model="framework" :variants="landing.variants" />
    </section>

    <section class="border-y border-default px-4 py-24 sm:px-8 lg:px-12">
      <p class="mx-auto max-w-4xl text-4xl font-medium leading-tight tracking-[-0.05em] text-highlighted text-balance sm:text-5xl">{{ landing.tagline }}</p>
    </section>

    <section class="mx-auto max-w-7xl px-4 py-16 sm:px-8 lg:px-12 lg:py-24">
      <div class="flex flex-wrap items-end justify-between gap-5 border-b border-default pb-5">
        <h2 class="text-2xl font-semibold tracking-[-0.04em] text-highlighted">Start from the file that matters</h2>
        <NuxtLink :to="landing.docsTo" class="text-sm text-muted hover:text-highlighted">Open documentation <span aria-hidden="true">↗</span></NuxtLink>
      </div>
    </section>
  </main>
</template>
