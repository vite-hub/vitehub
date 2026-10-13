<script setup lang="ts">
import { tokenize } from "./code";
import { sharedApi } from "./content";

const panes = sharedApi.panes.map((pane) => ({ ...pane, lines: pane.code.map(tokenize) }));
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div
        class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16"
      >
        <h2
          class="max-w-[18ch] text-3xl/9 font-semibold tracking-[-0.03em] text-highlighted text-balance sm:text-4xl/10"
        >
          Your Agent's tools are your app's APIs.
        </h2>
        <div class="max-w-[40ch] lg:justify-self-end">
          <p class="text-base/7 text-muted">
            A Capability wraps the same primitive that your routes call. Give the Agent read
            access, write access, or one named store.
          </p>
          <NuxtLink
            :to="sharedApi.capabilityTo"
            class="group mt-3 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            How Capabilities use primitives
            <UIcon
              name="i-lucide-arrow-right"
              class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>
      </div>

      <div class="mt-10 grid border border-default lg:mt-12 lg:grid-cols-2">
        <figure
          v-for="(pane, index) in panes"
          :key="pane.id"
          class="flex min-w-0 flex-col"
          :class="{ 'border-t border-default lg:border-t-0 lg:border-l': index > 0 }"
        >
          <div
            class="flex min-h-11 items-center gap-2 border-b border-default px-4 font-mono text-xs text-muted"
          >
            <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ pane.path }}</span>
            <span class="ml-auto shrink-0 font-sans text-dimmed">{{ pane.label }}</span>
          </div>
          <pre
            class="shared-code flex-1 overflow-x-auto px-4 py-5 font-mono text-xs/6 sm:text-[0.8125rem]/7"
          ><code><span
            v-for="(line, lineIndex) in pane.lines"
            :key="lineIndex"
            class="block"
          ><span
            v-for="(token, tokenIndex) in line"
            :key="tokenIndex"
            :class="`token-${token.kind}`"
          >{{ token.text }}</span>{{ "\n" }}</span></code></pre>
          <figcaption class="border-t border-default px-4 py-3 text-sm text-muted">
            {{ pane.caption }}
          </figcaption>
        </figure>
      </div>
    </div>
  </section>
</template>

<style scoped>
.shared-code {
  color: var(--ui-text-muted);
}

.shared-code code {
  display: block;
  min-width: max-content;
}

.token-keyword,
.token-call {
  color: var(--ui-text-highlighted);
}

.token-keyword {
  font-weight: 500;
}

.token-string {
  color: var(--ui-text-toned);
}

@media (hover: hover) and (pointer: fine) {
  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}
</style>
