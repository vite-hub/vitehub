<script setup lang="ts">
import { landingPrimitives } from "./content";
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div
        class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16"
      >
        <h2
          class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14"
        >
          The primitives underneath.
        </h2>
        <div class="max-w-[38ch] lg:justify-self-end">
          <p class="text-lg/8 text-muted">
            Use them from Agents through Capabilities, or call them directly from server code.
          </p>
          <NuxtLink
            to="/docs/server-primitives"
            class="group mt-4 inline-flex min-h-10 items-center gap-2 border-b border-highlighted font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Explore Server Primitives
            <UIcon
              name="i-lucide-arrow-right"
              class="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>
      </div>

      <ul
        class="mt-12 grid gap-px border border-default bg-[var(--ui-border)] sm:grid-cols-2 lg:mt-16 lg:grid-cols-4"
        role="list"
      >
        <li v-for="primitive in landingPrimitives" :key="primitive.id" class="min-w-0 bg-default">
          <NuxtLink
            :to="primitive.to"
            class="group flex h-full min-h-44 flex-col p-5 transition-colors duration-200 hover:bg-muted/35 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:p-6"
          >
            <div
              class="h-16 w-full text-muted transition-colors duration-200 group-hover:text-highlighted"
            >
              <LandingPrimitiveMotion :name="primitive.id" />
            </div>
            <div class="mt-auto pt-5">
              <h3 class="font-medium text-highlighted">
                {{ primitive.name }}
              </h3>
              <p class="mt-1 text-sm text-muted">
                {{ primitive.description }}
              </p>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </section>
</template>
