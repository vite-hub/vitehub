<script setup lang="ts">
import { motion, MotionConfig } from "motion-v";
import { tokenize } from "./code";
import { portabilityExamples } from "./content";

const activeIndex = ref(0);
const indicatorId = `portability-pattern-${useId()}`;
const activeExample = computed(() => portabilityExamples[activeIndex.value] ?? portabilityExamples[0]);
const activeLines = computed(() => activeExample.value.code.map(tokenize));

function select(index: number, event: MouseEvent) {
  activeIndex.value = index;
  // Seven tabs scroll sideways on small screens. Keep the chosen one in view.
  // SAFETY: the click handler is attached directly to each tab button.
  (event.currentTarget as HTMLElement).scrollIntoView({ inline: "nearest", block: "nearest" });
}
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)] lg:items-end lg:gap-20">
        <h2 class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14">
          Write once.<br>Deploy anywhere.
        </h2>
        <p class="max-w-[36ch] text-lg/7 text-muted text-pretty">
          Same code on every host. The host picks the provider.
        </p>
      </div>

      <MotionConfig reduced-motion="user">
        <div class="mt-10 lg:mt-14">
          <div
            class="pattern-choices -mx-4 flex flex-nowrap gap-x-6 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
            role="group"
            aria-label="Server code examples"
          >
            <button
              v-for="(example, index) in portabilityExamples"
              :key="example.id"
              type="button"
              class="pattern-choice relative min-h-12 shrink-0 py-3 text-sm whitespace-nowrap transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
              :class="index === activeIndex ? 'text-highlighted' : 'text-muted'"
              :aria-pressed="index === activeIndex"
              @click="select(index, $event)"
            >
              {{ example.label }}
              <motion.span
                v-if="index === activeIndex"
                :layout-id="indicatorId"
                :initial="false"
                :transition="{ type: 'spring', stiffness: 450, damping: 36 }"
                class="absolute inset-x-0 bottom-0 h-px bg-inverted"
                aria-hidden="true"
              />
            </button>
          </div>

          <div class="grid border border-default lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.8fr)]">
            <div class="flex min-w-0 flex-col">
              <div class="flex min-h-11 items-center justify-between gap-3 border-b border-default px-4 font-mono text-xs text-muted">
                <span class="flex min-w-0 items-center gap-2">
                  <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
                  <span class="truncate">{{ activeExample.path }}</span>
                </span>
                <NuxtLink
                  :to="activeExample.to"
                  :aria-label="`${activeExample.label} docs`"
                  class="group inline-flex shrink-0 items-center gap-1 font-sans text-xs text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <span class="hidden sm:inline">{{ activeExample.label }} docs</span>
                  <span class="sm:hidden">Docs</span>
                  <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-3.5 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
                </NuxtLink>
              </div>
              <Transition name="example" mode="out-in">
                <pre :key="activeExample.id" class="portability-code overflow-x-auto px-4 py-5 font-mono text-xs/6 sm:px-6 sm:text-sm/7"><code><span v-for="(line, lineIndex) in activeLines" :key="lineIndex"><span v-for="(token, tokenIndex) in line" :key="tokenIndex" :class="`token-${token.kind}`">{{ token.text }}</span>{{ "\n" }}</span></code></pre>
              </Transition>
            </div>

            <div class="flex flex-col border-t border-default lg:border-t-0 lg:border-l">
              <p class="flex min-h-11 items-center border-b border-default px-4 font-mono text-xs text-muted">Provider per host</p>
              <Transition name="example" mode="out-in">
                <ul :key="activeExample.id" class="provider-list flex-1" aria-label="Provider for each host">
                  <li v-for="host in activeExample.hosts" :key="host.name" class="flex min-h-12 items-center justify-between gap-4 border-b border-default px-4">
                    <span class="inline-flex items-center gap-2 text-sm text-highlighted">
                      <UIcon :name="host.icon" class="size-4 shrink-0 text-muted" aria-hidden="true" />
                      {{ host.name }}
                    </span>
                    <span class="text-right text-xs text-muted">{{ host.provider }}</span>
                  </li>
                </ul>
              </Transition>
              <NuxtLink
                to="/docs/frameworks-hosts/support-matrix"
                class="group inline-flex min-h-11 items-center gap-1.5 px-4 text-xs text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
              >
                Full support matrix
                <UIcon name="i-lucide-arrow-up-right" class="size-3.5 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
              </NuxtLink>
            </div>
          </div>
        </div>
      </MotionConfig>
    </div>
  </section>
</template>

<style scoped>
.portability-code {
  min-height: 17.5rem;
  color: var(--ui-text-muted);
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

.example-enter-active,
.example-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.example-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.example-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (hover: hover) and (pointer: fine) {
  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pattern-choice,
  .example-enter-active,
  .example-leave-active {
    transition: none;
  }

  .example-enter-from,
  .example-leave-to {
    transform: none;
  }
}
</style>
