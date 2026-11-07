<script setup lang="ts">
import { useIntersectionObserver, usePreferredReducedMotion, useRafFn } from "@vueuse/core";
import { cmsDemoCycle, cmsDemoEnd, cmsDemoFrame, cmsDemoSentence } from "~/utils/cms-console-demo";

// `::cms-console-demo` is the CMS hero: the Console document editor beside the site. An editor types a sentence,
// the draft saves, they publish, and the site shows the sentence. Every frame is a function of the loop time, so the
// server and readers who turn motion off see the last frame, with the document published.

const root = useTemplateRef<HTMLElement>("root");
const reducedMotion = usePreferredReducedMotion();
const visible = ref(false);
const paused = ref(false);
const time = ref(cmsDemoEnd);
const frame = computed(() => cmsDemoFrame(time.value));
const animated = computed(() => reducedMotion.value !== "reduce");

let started: number | undefined;
const { pause, resume } = useRafFn(({ timestamp }) => {
  started ??= timestamp - time.value;
  time.value = (timestamp - started) % cmsDemoCycle;
}, { immediate: false });

useIntersectionObserver(root, ([entry]) => {
  visible.value = entry?.isIntersecting ?? false;
});

watchEffect(() => {
  if (animated.value && visible.value && !paused.value) {
    started = undefined;
    resume();
    return;
  }
  pause();
  if (!animated.value) time.value = cmsDemoEnd;
});

const rail = ["i-lucide-bot", "i-lucide-database", "i-lucide-file-text", "i-lucide-plug", "i-lucide-settings"];
</script>

<template>
  <figure ref="root" class="vh-cms-demo not-prose" :data-phase="frame.phase">
    <div class="vh-cms-window" role="img" aria-label="An editor types a sentence in the ViteHub Console, the draft saves, they publish, and the site shows the sentence.">
      <div class="vh-cms-rail" aria-hidden="true">
        <span class="vh-cms-mark" />
        <UIcon v-for="icon in rail" :key="icon" :name="icon" class="vh-cms-rail-icon" :class="{ 'is-active': icon === 'i-lucide-file-text' }" />
      </div>

      <div class="vh-cms-editor" aria-hidden="true">
        <div class="vh-cms-header">
          <span class="vh-cms-trail"><UIcon name="i-lucide-chevron-left" class="size-3.5" />Posts</span>
          <span class="vh-cms-status" :data-tone="frame.status.tone">
            <span class="vh-cms-dot" />
            {{ frame.status.label }}
          </span>
          <span class="vh-cms-publish" :class="{ 'is-pressed': frame.pressed, 'is-busy': frame.phase === 'publishing' }">
            <span>{{ frame.phase === "publishing" ? "Publishing…" : "Publish" }}</span>
            <UIcon name="i-lucide-chevron-down" class="vh-cms-publish-more" />
            <svg class="vh-cms-pointer" :class="{ 'is-near': frame.pointer }" viewBox="0 0 16 20" aria-hidden="true">
              <path d="M1 1v15l4-3.5 2.6 6 2.6-1.1-2.6-5.9H13z" />
            </svg>
          </span>
        </div>

        <div class="vh-cms-page">
          <p class="vh-cms-title">Launch notes for October</p>
          <dl class="vh-cms-fields">
            <dt>Date</dt><dd>2026-10-31</dd>
            <dt>Tags</dt><dd><span class="vh-cms-tag">release</span></dd>
          </dl>
          <p class="vh-cms-body">We moved the blog onto the ViteHub CMS. Editors write here, and the site updates when they publish.</p>
          <p class="vh-cms-body vh-cms-typed" :class="{ 'is-fading': frame.fading }">
            {{ frame.typed }}<span class="vh-cms-caret" :class="{ 'is-typing': frame.phase === 'typing' }" />
          </p>
        </div>
      </div>

      <div class="vh-cms-site" aria-hidden="true">
        <div class="vh-cms-address">
          <span class="vh-cms-lights"><i /><i /><i /></span>
          <span class="vh-cms-url">example.com/blog/launch-notes</span>
        </div>
        <div class="vh-cms-site-page">
          <p class="vh-cms-site-kicker">Blog</p>
          <p class="vh-cms-site-title">Launch notes for October</p>
          <p class="vh-cms-site-meta">Oct 31, 2026 · release</p>
          <p class="vh-cms-site-body">We moved the blog onto the ViteHub CMS. Editors write here, and the site updates when they publish.</p>
          <p class="vh-cms-site-body vh-cms-site-new" :class="{ 'is-live': frame.published, 'is-fresh': frame.toast }">{{ cmsDemoSentence }}</p>
        </div>
        <span class="vh-cms-toast" :class="{ 'is-shown': frame.toast }">
          <UIcon name="i-lucide-check" class="size-3.5" />
          Published
        </span>
      </div>
    </div>

    <button
      v-if="animated"
      type="button"
      class="vh-cms-toggle"
      :aria-label="paused ? 'Play the animation' : 'Pause the animation'"
      @click="paused = !paused"
    >
      <UIcon :name="paused ? 'i-lucide-play' : 'i-lucide-pause'" class="size-3.5" />
    </button>
  </figure>
</template>

<style scoped>
.vh-cms-demo {
  position: relative;
  margin: 0;
  container-type: inline-size;
}

/* The window keeps one ratio, so typing and publishing never move the page. */
.vh-cms-window {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1.25fr) minmax(0, 1fr);
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg);
  color: var(--ui-text);
  font-size: 0.75rem;
  line-height: 1.4;
}

.vh-cms-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.875rem;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding-top: 0.75rem;
  color: var(--ui-text-dimmed);
}

.vh-cms-mark {
  width: 0.875rem;
  height: 0.875rem;
  margin-bottom: 0.25rem;
  background: var(--ui-text-highlighted);
  clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
}

.vh-cms-rail-icon {
  width: 0.875rem;
  height: 0.875rem;
}

.vh-cms-rail-icon.is-active {
  color: var(--ui-text-highlighted);
}

.vh-cms-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.vh-cms-header {
  display: flex;
  height: 2.5rem;
  flex: none;
  align-items: center;
  gap: 0.625rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.625rem 0 0.875rem;
  white-space: nowrap;
}

.vh-cms-trail {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--ui-text-muted);
}

.vh-cms-status {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  justify-content: flex-end;
  min-width: 7.5rem;
  margin-left: auto;
  color: var(--ui-text-muted);
}

.vh-cms-dot {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
  transition: background-color 200ms ease, box-shadow 200ms ease;
}

.vh-cms-status[data-tone="warning"] .vh-cms-dot {
  background: var(--ui-warning);
  box-shadow: none;
}

.vh-cms-status[data-tone="success"] .vh-cms-dot {
  background: var(--ui-success);
  box-shadow: none;
}

.vh-cms-publish {
  position: relative;
  display: inline-flex;
  height: 1.625rem;
  align-items: center;
  gap: 0.5rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-text-highlighted);
  padding: 0 0.375rem 0 0.625rem;
  color: var(--ui-bg);
  font-weight: 500;
  transition: transform 120ms ease-out, opacity 150ms ease;
}

.vh-cms-publish.is-pressed {
  transform: scale(0.96);
}

.vh-cms-publish.is-busy {
  opacity: 0.7;
}

.vh-cms-publish-more {
  width: 0.75rem;
  height: 0.75rem;
  border-left: 1px solid color-mix(in srgb, var(--ui-bg) 30%, transparent);
  padding-left: 0.25rem;
  box-sizing: content-box;
}

/* The pointer waits under the editor and glides onto Publish. */
.vh-cms-pointer {
  position: absolute;
  top: 60%;
  left: 30%;
  width: 0.875rem;
  fill: var(--ui-text-highlighted);
  stroke: var(--ui-bg);
  stroke-width: 1.2;
  opacity: 0;
  transform: translate(-4.5rem, 6rem);
  transition: transform 700ms cubic-bezier(0.32, 0.72, 0, 1), opacity 250ms ease;
}

.vh-cms-pointer.is-near {
  opacity: 1;
  transform: translate(0, 0);
}

.vh-cms-page {
  min-height: 0;
  overflow: hidden;
  padding: 1.25rem 1.25rem 0;
}

.vh-cms-title {
  margin: 0 0 0.75rem;
  color: var(--ui-text-highlighted);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.vh-cms-fields {
  display: grid;
  grid-template-columns: 3.5rem 1fr;
  gap: 0.375rem 0.5rem;
  margin: 0 0 1rem;
  border-bottom: 1px solid var(--ui-border);
  padding-bottom: 0.875rem;
}

.vh-cms-fields dt {
  color: var(--ui-text-muted);
}

.vh-cms-fields dd {
  margin: 0;
}

.vh-cms-tag {
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  padding: 0 0.375rem;
}

.vh-cms-body {
  min-height: 2.8em;
  margin: 0 0 0.625rem;
  text-wrap: pretty;
}

.vh-cms-typed {
  transition: opacity 300ms ease;
}

.vh-cms-typed.is-fading {
  opacity: 0;
}

.vh-cms-caret {
  display: inline-block;
  width: 1px;
  height: 1.1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--ui-text-highlighted);
  opacity: 0;
}

.vh-cms-caret.is-typing {
  opacity: 1;
}

.vh-cms-site {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.625rem;
}

.vh-cms-address {
  display: flex;
  height: 1.5rem;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--ui-border);
  border-bottom: 0;
  border-radius: var(--ui-radius) var(--ui-radius) 0 0;
  background: var(--ui-bg-elevated);
  padding: 0 0.5rem;
  color: var(--ui-text-dimmed);
  font-size: 0.625rem;
}

.vh-cms-lights {
  display: inline-flex;
  gap: 0.1875rem;
}

.vh-cms-lights i {
  width: 0.3125rem;
  height: 0.3125rem;
  border-radius: 999px;
  background: var(--ui-border-accented);
}

.vh-cms-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-cms-site-page {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  padding: 1rem 0.875rem;
  font-family: ui-serif, Georgia, serif;
}

.vh-cms-site-kicker {
  margin: 0 0 0.5rem;
  color: var(--ui-text-muted);
  font-family: var(--font-sans);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-cms-site-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 1.0625rem;
  font-weight: 700;
  line-height: 1.15;
}

.vh-cms-site-meta {
  margin: 0.375rem 0 0.75rem;
  color: var(--ui-text-muted);
  font-family: var(--font-sans);
  font-size: 0.625rem;
}

.vh-cms-site-body {
  margin: 0 0 0.5rem;
  font-size: 0.6875rem;
  line-height: 1.5;
}

/* The new sentence takes its space from the start, so the page below it never moves. */
.vh-cms-site-new {
  opacity: 0;
  transform: translateY(0.25rem);
  transition: opacity 300ms ease-out, transform 300ms ease-out, background-color 1200ms ease;
}

.vh-cms-site-new.is-live {
  opacity: 1;
  transform: none;
}

.vh-cms-site-new.is-fresh {
  background: color-mix(in srgb, var(--ui-success) 14%, transparent);
}

.vh-cms-toast {
  position: absolute;
  right: 1rem;
  bottom: 1rem;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg-elevated);
  padding: 0.375rem 0.625rem;
  color: var(--ui-text-highlighted);
  font-weight: 500;
  opacity: 0;
  transform: translateY(0.5rem);
  transition: opacity 200ms ease-out, transform 200ms ease-out;
}

.vh-cms-toast.is-shown {
  opacity: 1;
  transform: none;
}

/* The button sits over the rail, away from the toast. */
.vh-cms-toggle {
  position: absolute;
  bottom: 0.375rem;
  left: 0.375rem;
  display: inline-flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: var(--ui-radius);
  color: var(--ui-text-muted);
  opacity: 0;
  transition: opacity 150ms ease;
}

.vh-cms-demo:hover .vh-cms-toggle,
.vh-cms-toggle:focus-visible {
  opacity: 1;
}

.vh-cms-toggle:hover {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

@media (pointer: coarse) {
  .vh-cms-toggle {
    opacity: 1;
  }
}

/* On narrow panels the rail goes, and the site preview takes the lower part of the window. */
@container (max-width: 34rem) {
  .vh-cms-window {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1.2fr) minmax(0, 1fr);
    aspect-ratio: 4 / 5;
  }

  .vh-cms-rail {
    display: none;
  }

  .vh-cms-site {
    border-top: 1px solid var(--ui-border);
    border-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .vh-cms-demo * {
    transition: none !important;
  }
}
</style>
