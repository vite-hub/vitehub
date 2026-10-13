<script setup lang="ts">
import { NuxtLink } from "#components";
import { closingFacts, closingHosts } from "./content";

const hostNames = closingHosts.map((host) => host.name).join(", ");
</script>

<template>
  <section class="bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="flex flex-col items-center text-center">
        <h2 class="max-w-[16ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14">
          Ship the server part with your Vite app.
        </h2>

        <div class="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
          <UButton
            to="/docs/getting-started/first-server-primitive"
            label="Build your first primitive"
            trailing-icon="i-lucide-arrow-right"
            color="neutral"
            size="lg"
            class="closing-cta h-10 rounded-none px-4"
          />
          <NuxtLink
            to="/docs/getting-started/first-agent"
            class="inline-flex min-h-10 items-center gap-1.5 text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Build your first Agent
            <UIcon name="i-lucide-arrow-up-right" class="size-3.5" aria-hidden="true" />
          </NuxtLink>
        </div>
      </div>

      <ul class="closing-facts mt-12 grid sm:grid-cols-2 lg:mt-16 lg:grid-cols-4" aria-label="Before you start">
        <li v-for="fact in closingFacts" :key="fact.id" class="min-w-0">
          <component
            :is="'to' in fact ? NuxtLink : 'div'"
            v-bind="'to' in fact ? { to: fact.to } : {}"
            class="closing-fact"
            :class="{ 'is-link': 'to' in fact }"
          >
            <UIcon name="i-lucide-check" class="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span>{{ fact.label }}</span>
            <span v-if="fact.id === 'hosts'" class="flex items-center gap-2 text-muted">
              <UIcon v-for="host in closingHosts" :key="host.name" :name="host.icon" class="size-4" aria-hidden="true" />
              <span class="sr-only">{{ hostNames }}</span>
            </span>
            <UIcon v-if="'to' in fact" name="i-lucide-arrow-up-right" class="closing-arrow ml-auto size-3.5 shrink-0" aria-hidden="true" />
          </component>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.closing-facts {
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}

.closing-fact {
  display: flex;
  height: 100%;
  min-height: 3.5rem;
  align-items: center;
  gap: 0.75rem;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 0.75rem 1.25rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  transition: background-color 200ms ease;
}

.closing-fact.is-link:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

.closing-arrow {
  color: var(--ui-text-muted);
  transition: color 180ms ease, transform 180ms ease;
}

.closing-cta :deep(.iconify) {
  transition: transform 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .closing-fact.is-link:hover {
    background: color-mix(in srgb, var(--ui-bg-muted) 45%, transparent);
  }

  .closing-fact.is-link:hover .closing-arrow {
    color: var(--ui-text-highlighted);
    transform: translate(1px, -1px);
  }

  .closing-cta:hover :deep(.iconify) {
    transform: translateX(0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .closing-fact,
  .closing-arrow,
  .closing-cta :deep(.iconify) {
    transition: none;
    transform: none;
  }
}
</style>
