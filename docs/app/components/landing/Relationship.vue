<script setup lang="ts">
import { agentBoundaries, serverPrimitives } from "./content"
</script>

<template>
  <section class="border-b border-default bg-muted/20">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-28">
      <div class="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(30rem,1.28fr)] lg:items-end lg:gap-16">
        <div>
          <p class="font-mono text-xs/5 font-medium tracking-[0.16em] text-muted uppercase">
            The map / Composition
          </p>
          <h2 class="mt-5 max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12">
            The primitive is the floor, not the ceiling.
          </h2>
        </div>
        <p class="max-w-[58ch] text-lg/8 text-muted text-pretty lg:justify-self-end">
          Every Server Primitive works in ordinary application code. When an Agent needs one, ViteHub exposes it through an explicit Capability instead of handing the Agent raw global access.
        </p>
      </div>

      <div class="mt-12 border border-default bg-default lg:mt-16">
        <div class="grid lg:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)]">
          <article class="min-w-0 p-5 sm:p-8 lg:p-10">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-default pb-5">
              <div>
                <p class="font-mono text-[0.6875rem]/4 tracking-[0.16em] text-muted uppercase">Layer 01</p>
                <h3 class="mt-2 text-2xl/8 font-semibold text-highlighted">Server Primitives</h3>
              </div>
              <span class="rounded-full border border-default px-2.5 py-1 font-mono text-[0.6875rem]/4 text-muted">
                Works independently
              </span>
            </div>

            <ul class="grid grid-cols-2 border-l border-t border-default sm:grid-cols-3" role="list">
              <li v-for="primitive in serverPrimitives" :key="primitive.name" class="min-w-0 border-r border-b border-default">
                <NuxtLink
                  :to="primitive.to"
                  class="group flex min-h-12 items-center justify-between gap-2 px-3 py-2 text-base/6 font-medium text-default hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:text-sm/6"
                >
                  <span class="min-w-0 truncate">{{ primitive.name }}</span>
                  <UIcon name="i-lucide-arrow-up-right" class="size-3.5 shrink-0 text-dimmed group-hover:text-default" aria-hidden="true" />
                </NuxtLink>
              </li>
            </ul>

            <p class="mt-5 max-w-[48ch] text-base/7 text-muted sm:text-sm/6">
              Import a stable Runtime Helper from a route, job, or worker. Keep the provider decision in the Vite Integration.
            </p>
          </article>

          <div class="vh-compose-bridge relative flex min-h-28 items-center justify-center border-y border-default px-4 py-7 lg:min-h-0 lg:border-x lg:border-y-0">
            <div class="relative z-10 max-w-28 bg-default px-2 text-center font-mono text-[0.6875rem]/5 tracking-[0.1em] text-muted uppercase">
              Expose only what is needed
            </div>
          </div>

          <article class="min-w-0 p-5 sm:p-8 lg:p-10">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-default pb-5">
              <div>
                <p class="font-mono text-[0.6875rem]/4 tracking-[0.16em] text-muted uppercase">Layer 02</p>
                <h3 class="mt-2 text-2xl/8 font-semibold text-highlighted">Agent Definition</h3>
              </div>
              <span class="rounded-full border border-default px-2.5 py-1 font-mono text-[0.6875rem]/4 text-muted">
                Composes explicitly
              </span>
            </div>

            <ol class="border-l border-t border-default" role="list">
              <li v-for="(boundary, index) in agentBoundaries" :key="boundary.name" class="border-r border-b border-default">
                <NuxtLink
                  :to="boundary.to"
                  class="group grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-3 px-3 py-3 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                >
                  <span class="pt-0.5 font-mono text-xs/5 text-dimmed">0{{ index + 1 }}</span>
                  <span class="min-w-0">
                    <strong class="block text-base/6 font-medium text-highlighted sm:text-sm/6">{{ boundary.name }}</strong>
                    <span class="mt-0.5 block text-base/6 text-muted sm:text-sm/6">{{ boundary.description }}</span>
                  </span>
                  <UIcon name="i-lucide-arrow-up-right" class="mt-1 size-3.5 shrink-0 text-dimmed group-hover:text-default" aria-hidden="true" />
                </NuxtLink>
              </li>
            </ol>
          </article>
        </div>

        <div class="grid border-t border-default sm:grid-cols-2">
          <p class="px-5 py-4 text-base/7 text-default sm:px-8 sm:text-sm/6 lg:px-10">
            <span class="font-medium text-highlighted">Primitive path:</span> configure it, import it, call it.
          </p>
          <p class="border-t border-default px-5 py-4 text-base/7 text-default sm:border-t-0 sm:border-l sm:px-8 sm:text-sm/6 lg:px-10">
            <span class="font-medium text-highlighted">Agent path:</span> define it, inspect it, invoke it.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vh-compose-bridge::before {
  position: absolute;
  top: 50%;
  right: 1.25rem;
  left: 1.25rem;
  height: 1px;
  background: var(--ui-border);
  content: "";
}

.vh-compose-bridge::after {
  position: absolute;
  right: 1.25rem;
  top: calc(50% - 0.25rem);
  width: 0.5rem;
  height: 0.5rem;
  border-top: 1px solid var(--ui-text-muted);
  border-right: 1px solid var(--ui-text-muted);
  content: "";
  transform: rotate(45deg);
}

@media (max-width: 63.999rem) {
  .vh-compose-bridge::before {
    top: 1.25rem;
    bottom: 1.25rem;
    left: 50%;
    width: 1px;
    height: auto;
  }

  .vh-compose-bridge::after {
    right: auto;
    top: auto;
    bottom: 1.25rem;
    left: calc(50% - 0.25rem);
    transform: rotate(135deg);
  }
}
</style>
