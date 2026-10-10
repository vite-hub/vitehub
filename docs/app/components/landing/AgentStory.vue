<script setup lang="ts">
import { useIntersectionObserver, usePreferredReducedMotion } from "@vueuse/core";
import { tokenize } from "./code";
import { agentStory } from "./content";

const stepDuration = 2600;
const lastStep = agentStory.steps.length - 1;

const section = useTemplateRef<HTMLElement>("section");
const reducedMotion = usePreferredReducedMotion();
const activeIndex = ref(0);
const played = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const activeStep = computed(() => agentStory.steps[activeIndex.value]!);
const activeLines = computed<readonly number[]>(() => activeStep.value.lines);
const traceNodes = computed(() => [
  ...agentStory.steps.map((step, index) => ({ id: step.id, label: step.label, lit: index <= activeIndex.value })),
  { id: "reply", label: "Reply", lit: activeIndex.value === lastStep },
]);
// Nodes sit at equal intervals. The last step also reaches the reply node.
const traceProgress = computed(() =>
  activeIndex.value === lastStep ? 1 : activeIndex.value / agentStory.steps.length,
);

function stopTour() {
  clearTimeout(timer);
  timer = undefined;
}

function advance() {
  if (activeIndex.value >= lastStep) {
    stopTour();
    return;
  }
  activeIndex.value += 1;
  timer = setTimeout(advance, stepDuration);
}

// Play the story once when it enters the viewport, then leave control to the reader.
useIntersectionObserver(
  section,
  ([entry]) => {
    if (!entry?.isIntersecting || played.value || reducedMotion.value === "reduce") {
      return;
    }
    played.value = true;
    timer = setTimeout(advance, stepDuration);
  },
  { threshold: 0.45 },
);

function selectStep(index: number) {
  played.value = true;
  stopTour();
  activeIndex.value = index;
}

onBeforeUnmount(stopTour);

const codeLines = agentStory.code.map(tokenize);
</script>

<template>
  <section ref="section" class="border-b border-default bg-muted/20">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div
        class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16"
      >
        <h2
          class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14"
        >
          One file. One Agent.
        </h2>
        <p class="max-w-[38ch] text-lg/8 text-muted lg:justify-self-end">
          Each field answers one question. ViteHub discovers the file and runs it on your host.
        </p>
      </div>

      <div
        class="mt-12 grid border border-default bg-default lg:mt-16 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]"
      >
        <ol class="story-steps" :style="{ '--active-index': activeIndex, '--step-count': agentStory.steps.length }" aria-label="How the Agent runs">
          <li v-for="(step, index) in agentStory.steps" :key="step.id">
            <button
              type="button"
              class="story-step"
              :class="{ 'is-active': index === activeIndex }"
              :aria-pressed="index === activeIndex"
              @click="selectStep(index)"
            >
              <span class="font-mono text-xs text-dimmed">
                {{ String(index + 1).padStart(2, "0") }} · {{ step.label }}
              </span>
              <span class="mt-1.5 block text-lg/7 font-medium text-highlighted sm:text-xl/7">
                {{ step.title }}
              </span>
              <span class="mt-1 block max-w-[52ch] text-sm/6 text-muted">
                {{ step.description }}
              </span>
            </button>
          </li>
        </ol>

        <div class="flex min-w-0 flex-col border-t border-default lg:border-t-0 lg:border-l">
          <div
            class="flex min-h-11 items-center justify-between gap-3 border-b border-default px-4 font-mono text-xs text-muted"
          >
            <span class="flex min-w-0 items-center gap-2">
              <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ agentStory.path }}</span>
            </span>
            <NuxtLink
              :to="activeStep.to"
              class="group inline-flex shrink-0 items-center gap-1 font-sans text-xs text-muted transition-colors hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {{ activeStep.label }} docs
              <UIcon
                name="i-lucide-arrow-right"
                class="landing-cta-arrow size-3.5 transition-transform duration-200 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </NuxtLink>
          </div>

          <pre
            class="story-code flex flex-1 flex-col justify-center overflow-x-auto py-5 font-mono text-xs/6 sm:text-[0.8125rem]/7 lg:text-sm/8"
          ><code><span
            v-for="(line, index) in codeLines"
            :key="index"
            class="story-line"
            :class="{ 'is-active': activeLines.includes(index), 'is-dimmed': activeLines.length && !activeLines.includes(index) }"
          ><span class="story-line-number" aria-hidden="true">{{ index + 1 }}</span><span
            v-for="(token, tokenIndex) in line"
            :key="tokenIndex"
            :class="`token-${token.kind}`"
          >{{ token.text }}</span>{{ "\n" }}</span></code></pre>

          <div class="border-t border-default px-4 py-4 sm:px-6">
            <p class="font-mono text-[0.6875rem] text-dimmed">Invocation</p>
            <div class="story-trace mt-3" :style="{ '--trace-progress': traceProgress }">
              <span class="story-trace-rail" aria-hidden="true"><span /></span>
              <span
                v-for="node in traceNodes"
                :key="node.id"
                class="story-trace-node"
                :class="{ 'is-lit': node.lit, 'is-reply': node.id === 'reply' }"
              >
                <span class="story-trace-dot" aria-hidden="true" />
                <span class="story-trace-label">{{ node.label }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story-steps {
  position: relative;
  display: grid;
  grid-auto-rows: 1fr;
}

/* One rail marker moves between steps instead of each step drawing its own border. */
.story-steps::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--ui-border);
  content: "";
}

.story-steps::after {
  position: absolute;
  top: 0;
  left: 0;
  width: 2px;
  height: calc(100% / var(--step-count));
  background: var(--ui-text-highlighted);
  content: "";
  transform: translateY(calc(var(--active-index) * 100%));
  transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
}

.story-steps > li + li {
  border-top: 1px solid var(--ui-border);
}

.story-step {
  display: block;
  width: 100%;
  height: 100%;
  padding: 1.125rem 1.25rem 1.125rem 1.5rem;
  text-align: left;
  opacity: 0.62;
  transition: opacity 240ms ease, background-color 240ms ease;
}

.story-step.is-active {
  opacity: 1;
  background: color-mix(in srgb, var(--ui-bg-muted) 45%, transparent);
}

.story-step:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

@media (hover: hover) and (pointer: fine) {
  .story-step:hover {
    opacity: 1;
  }

  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}

@media (min-width: 64rem) {
  .story-step {
    padding: 1.375rem 2rem 1.375rem 2.25rem;
  }
}

.story-code {
  color: var(--ui-text-muted);
}

.story-code code {
  display: block;
  min-width: max-content;
}

.story-line {
  position: relative;
  display: block;
  padding-right: 1.5rem;
  transition: opacity 280ms ease, background-color 280ms ease;
}

.story-line::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: var(--ui-text-highlighted);
  content: "";
  transform: scaleY(0);
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}

.story-line.is-active {
  background: color-mix(in srgb, var(--ui-bg-muted) 70%, transparent);
}

.story-line.is-active::before {
  transform: scaleY(1);
}

.story-line.is-dimmed {
  opacity: 0.42;
}

.story-line-number {
  display: inline-block;
  width: 3rem;
  padding-right: 1.25rem;
  color: var(--ui-text-dimmed);
  text-align: right;
  user-select: none;
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

.story-trace {
  position: relative;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.story-trace-rail {
  position: absolute;
  top: 0.3125rem;
  right: 10%;
  left: 10%;
  height: 1px;
  overflow: hidden;
  background: var(--ui-border-accented);
}

.story-trace-rail > span {
  position: absolute;
  inset: 0;
  background: var(--ui-text-highlighted);
  transform: scaleX(var(--trace-progress));
  transform-origin: left;
  transition: transform 900ms cubic-bezier(0.65, 0, 0.35, 1);
}

.story-trace-node {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.story-trace-dot {
  width: 0.625rem;
  height: 0.625rem;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  background: var(--ui-bg);
  transition: background-color 200ms ease 250ms, border-color 200ms ease 250ms, transform 200ms ease 250ms;
}

.story-trace-node.is-lit .story-trace-dot {
  border-color: var(--ui-text-highlighted);
  background: var(--ui-text-highlighted);
}

.story-trace-node.is-reply.is-lit .story-trace-dot {
  transform: scale(1.3);
  transition-delay: 800ms;
}

.story-trace-label {
  max-width: 100%;
  overflow: hidden;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 200ms ease 250ms;
}

.story-trace-node.is-lit .story-trace-label {
  color: var(--ui-text-highlighted);
}

.story-trace-node.is-reply.is-lit .story-trace-label {
  transition-delay: 800ms;
}

@media (prefers-reduced-motion: reduce) {
  .story-steps::after,
  .story-step,
  .story-line,
  .story-line::before,
  .story-trace-rail > span,
  .story-trace-dot,
  .story-trace-label {
    transition: none;
  }
}
</style>
