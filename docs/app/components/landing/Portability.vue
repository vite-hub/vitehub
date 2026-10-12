<script setup lang="ts">
import { motion, MotionConfig } from "motion-v";
import { tokenize } from "./code";
import { portabilityExamples } from "./content";

const activeIndex = ref(0);
const indicatorId = `portability-pattern-${useId()}`;
const activeExample = computed(() => portabilityExamples[activeIndex.value] ?? portabilityExamples[0]);
const activeLines = computed(() => activeExample.value.code.map(tokenize));
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)] lg:items-end lg:gap-20">
        <h2 class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.05em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14">
          Write once.<br>Deploy anywhere.
        </h2>
        <p class="max-w-[44ch] text-lg/7 text-muted text-pretty">
          Your application owns the logic. ViteHub connects it to the host's services. Switch
          providers through configuration, and keep your server code.
        </p>
      </div>

      <MotionConfig reduced-motion="user">
        <div class="mt-10 lg:mt-14">
          <div class="pattern-choices flex flex-wrap gap-x-6 gap-y-1 border-b border-default" role="group" aria-label="Server code examples">
            <button
              v-for="(example, index) in portabilityExamples"
              :key="example.id"
              type="button"
              class="pattern-choice relative min-h-12 py-3 text-sm transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
              :class="index === activeIndex ? 'text-highlighted' : 'text-muted'"
              :aria-pressed="index === activeIndex"
              @click="activeIndex = index"
            >
              {{ example.label }}
              <motion.span
                v-if="index === activeIndex"
                :layout-id="indicatorId"
                :initial="false"
                :transition="{ type: 'spring', stiffness: 450, damping: 36 }"
                class="absolute inset-x-0 -bottom-px h-px bg-inverted"
                aria-hidden="true"
              />
            </button>
          </div>

          <div class="grid lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.8fr)] lg:gap-16">
            <div class="min-w-0 py-6 sm:py-8">
              <div class="flex items-center gap-2 font-mono text-xs text-dimmed">
                <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
                <span>{{ activeExample.path }}</span>
              </div>
              <Transition name="example" mode="out-in">
                <div :key="activeExample.id">
                  <pre class="portability-code mt-5 overflow-x-auto font-mono text-xs/6 sm:text-sm/7"><code><span v-for="(line, lineIndex) in activeLines" :key="lineIndex"><span v-for="(token, tokenIndex) in line" :key="tokenIndex" :class="`token-${token.kind}`">{{ token.text }}</span>{{ "\n" }}</span></code></pre>
                  <p class="mt-5 text-sm/6 text-muted">{{ activeExample.description }}</p>
                </div>
              </Transition>
            </div>

            <div class="border-t border-default py-6 sm:py-8 lg:border-t-0">
              <p class="text-sm text-muted">Same API, different providers.</p>
              <Transition name="example" mode="out-in">
                <ul :key="activeExample.id" class="provider-list mt-5 min-h-44" aria-label="Supported providers for this example">
                  <li v-for="host in activeExample.hosts" :key="host.name" class="flex items-center justify-between gap-4 border-b border-default py-3 first:pt-0">
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
                class="group mt-4 inline-flex min-h-9 items-center gap-1.5 text-xs text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
              >
                Check host support
                <UIcon name="i-lucide-arrow-up-right" class="size-3.5 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
              </NuxtLink>
            </div>
          </div>
        </div>
      </MotionConfig>

      <div class="mt-6 grid gap-8 border-t border-default pt-8 sm:grid-cols-2 lg:mt-10 lg:gap-20">
        <div>
          <h3 class="text-base font-medium text-highlighted">Use the pieces you need.</h3>
          <p class="mt-2 max-w-[48ch] text-sm/6 text-muted">
            Each primitive works on its own. Call it from a route, a background job, or an Agent.
            Enable more when your application needs them.
          </p>
        </div>
        <div>
          <h3 class="text-base font-medium text-highlighted">Keep it in your Vite stack.</h3>
          <p class="mt-2 max-w-[48ch] text-sm/6 text-muted">
            Built with the UnJS ecosystem. Use TypeScript, native responses, and the same tools
            you already use with Vite and Nuxt.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.portability-code {
  min-height: 15.75rem;
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
