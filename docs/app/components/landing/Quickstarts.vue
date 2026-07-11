<script setup lang="ts">
import { landingLanes } from "./content"
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-28">
      <div class="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(30rem,1.1fr)] lg:items-end lg:gap-16">
        <div>
          <p class="font-mono text-xs/5 font-medium tracking-[0.16em] text-muted uppercase">
            First success / Choose one
          </p>
          <h2 class="mt-5 max-w-[14ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12">
            Start with the smallest thing that can run.
          </h2>
        </div>
        <p class="max-w-[58ch] text-lg/8 text-muted text-pretty lg:justify-self-end">
          Both paths end in ordinary server code and a visible result. The tutorials include installation, Vite Integration, files, commands, and the proof that tells you it works.
        </p>
      </div>

      <div class="mt-12 grid border border-default lg:mt-16 lg:grid-cols-2">
        <article
          v-for="(lane, index) in landingLanes"
          :key="lane.id"
          class="flex min-w-0 flex-col"
          :class="index === 1 ? 'border-t border-default lg:border-t-0 lg:border-l' : ''"
        >
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-default bg-muted/40 px-4 py-3 sm:px-6">
            <div class="flex min-w-0 items-center gap-3">
              <span class="font-mono text-xs/5 text-dimmed">{{ lane.number }}</span>
              <h3 class="truncate text-base/6 font-medium text-highlighted">{{ lane.name }}</h3>
            </div>
            <span class="font-mono text-[0.6875rem]/4 tracking-[0.12em] text-muted uppercase">Verified contract</span>
          </div>

          <div class="flex min-h-12 items-center gap-2 border-b border-default px-4 py-2.5 sm:px-6">
            <UIcon name="i-vscode-icons-file-type-typescript-official" class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate font-mono text-xs/5 text-muted">{{ lane.codeLabel }}</span>
          </div>

          <pre class="vh-contract min-h-[18rem] flex-1 overflow-x-auto bg-inverted p-4 text-base/7 text-inverted sm:p-6 sm:text-sm/6" tabindex="0"><code>{{ lane.code }}</code></pre>

          <div class="border-t border-default p-5 sm:p-6">
            <p class="max-w-[52ch] text-base/7 text-muted sm:text-sm/6">
              {{ lane.proof }}
            </p>
            <div class="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
              <NuxtLink
                :to="lane.tutorialPath"
                class="inline-flex min-h-12 items-center gap-2 font-medium text-highlighted hover:text-primary"
              >
                {{ lane.action }}
                <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
              </NuxtLink>
              <NuxtLink
                :to="lane.docsPath"
                class="inline-flex min-h-12 items-center text-base/6 font-medium text-muted hover:text-default sm:text-sm/6"
              >
                {{ lane.docsAction }}
              </NuxtLink>
            </div>
          </div>
        </article>
      </div>

      <p class="mt-5 max-w-[72ch] text-base/7 text-muted sm:text-sm/6">
        Hosted behavior depends on the selected Vite integration, runtime, and provider. Check the framework and host guides before treating a deployment target as supported.
      </p>
    </div>
  </section>
</template>

<style scoped>
.vh-contract {
  font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-variant-ligatures: none;
  tab-size: 2;
}

.vh-contract:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}
</style>
