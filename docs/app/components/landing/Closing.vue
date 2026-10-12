<script setup lang="ts">
import { closingPaths, nuxtHubMigration } from "./content";
</script>

<template>
  <section class="bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 class="max-w-[15ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14">
            Ship the server part with your Vite app.
          </h2>
          <p class="mt-4 max-w-[44ch] text-lg/8 text-muted">
            Start with one primitive. Built on UnJS, with TypeScript and native responses.
          </p>
        </div>

        <UButton
          to="/docs/getting-started/first-server-primitive"
          label="Build your first primitive"
          trailing-icon="i-lucide-arrow-right"
          color="neutral"
          size="lg"
          class="closing-cta h-10 self-start rounded-none px-4 lg:self-end"
        />
      </div>

      <ul class="closing-grid mt-10 grid lg:mt-14 lg:grid-cols-3" aria-label="Where to start">
        <li v-for="path in closingPaths" :key="path.id" class="min-w-0">
          <NuxtLink :to="path.to" class="closing-cell group">
            <div>
              <h3 class="text-sm font-medium text-highlighted">{{ path.title }}</h3>
              <p v-if="path.id !== 'nuxthub'" class="mt-1 text-sm/6 text-muted">{{ path.description }}</p>
              <ul v-else class="mt-2 space-y-1 font-mono text-[0.6875rem]/5 whitespace-nowrap text-muted">
                <li v-for="entry in nuxtHubMigration.imports" :key="entry.from">
                  {{ entry.from }} <span class="text-dimmed">→</span> {{ entry.to }}
                </li>
              </ul>
            </div>
            <UIcon name="i-lucide-arrow-up-right" class="closing-arrow size-3.5" aria-hidden="true" />
          </NuxtLink>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.closing-grid {
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}

.closing-cell {
  position: relative;
  display: flex;
  height: 100%;
  flex-direction: column;
  justify-content: space-between;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 1.25rem 2.5rem 1.25rem 1.25rem;
  transition: background-color 200ms ease;
}

@media (min-width: 640px) {
  .closing-cell {
    min-height: 9rem;
  }
}

.closing-cell:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

.closing-arrow {
  position: absolute;
  top: 1.25rem;
  right: 1.25rem;
  color: var(--ui-text-muted);
  transition: color 180ms ease, transform 180ms ease;
}

.closing-cta :deep(.iconify) {
  transition: transform 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .closing-cell:hover {
    background: color-mix(in srgb, var(--ui-bg-muted) 45%, transparent);
  }

  .closing-cell:hover .closing-arrow {
    color: var(--ui-text-highlighted);
    transform: translate(1px, -1px);
  }

  .closing-cta:hover :deep(.iconify) {
    transform: translateX(0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .closing-cell,
  .closing-arrow,
  .closing-cta :deep(.iconify) {
    transition: none;
    transform: none;
  }
}
</style>
