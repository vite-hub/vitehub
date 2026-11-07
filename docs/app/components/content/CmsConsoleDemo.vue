<script setup lang="ts">
import { useIntersectionObserver, usePreferredReducedMotion, useRafFn } from "@vueuse/core";
import { cmsDemoCycle, cmsDemoEnd, cmsDemoFrame, cmsDemoSentence } from "~/utils/cms-console-demo";

// `::cms-console-demo` is the CMS hero: the Console document editor beside a preview of the site. An editor types a
// sentence into a live post, the draft saves and the preview turns into a draft preview, they publish, and the
// preview is the live page again with the new sentence.
// Every frame is a function of the loop time, so the server and readers who turn motion off see the last frame,
// with the document published.

const root = useTemplateRef<HTMLElement>("root");
const reducedMotion = usePreferredReducedMotion();
const visible = ref(false);
const paused = ref(false);
const time = ref(cmsDemoEnd);
const frame = computed(() => cmsDemoFrame(time.value));
// The server cannot know the motion setting, so the first render is the still frame with no pause button on both
// sides. Motion starts after hydration.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
const animated = computed(() => mounted.value && reducedMotion.value !== "reduce");

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
</script>

<template>
  <figure ref="root" class="vh-cms-demo not-prose" :data-phase="frame.phase">
    <div class="vh-cms-window" role="img" aria-label="An editor types a new sentence into a live post in the ViteHub Console. The draft saves, and the site preview shows it under a draft banner. They click Publish, and the live site shows the new sentence.">
      <div class="vh-cms-rail" aria-hidden="true">
        <span class="vh-cms-mark" />
        <span class="vh-cms-rail-item is-active"><UIcon name="i-lucide-newspaper" /></span>
        <span class="vh-cms-rail-item"><UIcon name="i-lucide-database" /></span>
        <span class="vh-cms-rail-item vh-cms-rail-end"><UIcon name="i-lucide-settings" /></span>
      </div>

      <div class="vh-cms-editor" aria-hidden="true">
        <div class="vh-cms-header">
          <span class="vh-cms-trail"><UIcon name="i-lucide-chevron-left" class="size-3.5" />Posts</span>
          <span class="vh-cms-status" :data-tone="frame.status.tone">
            <span class="vh-cms-dot" />
            <span class="vh-cms-status-label">{{ frame.status.label }}</span>
          </span>
          <span class="vh-cms-publish" :class="{ 'is-pressed': frame.pressed, 'is-busy': frame.phase === 'publishing', 'is-done': !frame.changed }">
            <span class="vh-cms-publish-label">Publish</span>
            <span class="vh-cms-spinner" />
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
          <p class="vh-cms-body vh-cms-typed" :class="{ 'is-fading': frame.fading, 'is-changed': frame.changed }">
            {{ frame.typed }}<span class="vh-cms-caret" :class="{ 'is-on': frame.caret }" />
          </p>
        </div>
      </div>

      <div class="vh-cms-site" aria-hidden="true">
        <div class="vh-cms-browser">
          <div class="vh-cms-address">
            <span class="vh-cms-lights"><i /><i /><i /></span>
            <span class="vh-cms-url">
              <UIcon name="i-lucide-lock" class="vh-cms-lock" />
              <span>fieldnotes.dev/blog/launch-notes</span>
            </span>
          </div>

          <div class="vh-cms-banner" :data-state="frame.banner">
            <span class="vh-cms-banner-state is-draft">
              <UIcon name="i-lucide-eye" class="vh-cms-banner-icon" />
              <span><b>Draft preview</b>, only you can see this</span>
            </span>
            <span class="vh-cms-banner-state is-live">
              <UIcon name="i-lucide-check" class="vh-cms-banner-icon" />
              <span><b>Live</b>, everyone can see this</span>
            </span>
          </div>

          <div class="vh-cms-site-page">
            <div class="vh-cms-site-nav">
              <span class="vh-cms-site-brand"><i />Field Notes</span>
              <span class="vh-cms-site-links"><span class="is-current">Blog</span><span>About</span></span>
            </div>

            <div class="vh-cms-cover">
              <svg viewBox="0 0 240 72" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                <circle cx="168" cy="50" r="22" class="vh-cms-cover-sun" />
                <path d="M0 52 C40 44 70 58 110 50 S190 40 240 48 V72 H0Z" class="vh-cms-cover-far" />
                <path d="M0 60 C50 54 90 66 140 59 S210 54 240 58 V72 H0Z" class="vh-cms-cover-near" />
              </svg>
            </div>

            <p class="vh-cms-site-kicker">Release notes<span>Oct 31, 2026</span></p>
            <p class="vh-cms-site-title">Launch notes for October</p>
            <p class="vh-cms-site-byline"><span class="vh-cms-avatar">AR</span>Ana Ruiz<span class="vh-cms-site-read">2 min read</span></p>
            <p class="vh-cms-site-body">We moved the blog onto the ViteHub CMS. Editors write here, and the site updates when they publish.</p>
            <p class="vh-cms-site-body vh-cms-site-new" :data-state="frame.sentence" :class="{ 'is-fresh': frame.fresh }">{{ cmsDemoSentence }}</p>
          </div>
        </div>
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

/*
 * The window keeps one ratio, and every part that changes keeps its space, so typing and publishing never move the
 * page. Motion uses two curves: a strong ease-out for things that appear, and an ease-in-out for the pointer, which
 * moves across the screen.
 */
.vh-cms-window {
  --vh-cms-out: cubic-bezier(0.23, 1, 0.32, 1);
  --vh-cms-move: cubic-bezier(0.645, 0.045, 0.355, 1);
  --vh-cms-accent: oklch(0.58 0.14 40);
  --vh-cms-cover: oklch(0.95 0.025 70);
  --vh-cms-draft: oklch(0.6 0.13 75);
  --vh-cms-live: oklch(0.6 0.14 155);

  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1.15fr) minmax(0, 1fr);
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg);
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 0.07),
    0 1px 3px rgb(0 0 0 / 0.05),
    0 12px 32px -12px rgb(0 0 0 / 0.12);
  color: var(--ui-text);
  font-size: 0.75rem;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}

:root.dark .vh-cms-window {
  --vh-cms-accent: oklch(0.76 0.1 45);
  --vh-cms-cover: oklch(0.27 0.02 60);
  --vh-cms-draft: oklch(0.8 0.12 80);
  --vh-cms-live: oklch(0.78 0.13 155);

  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.09);
}

.vh-cms-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.875rem 0 0.625rem;
  color: var(--ui-text-dimmed);
}

.vh-cms-mark {
  width: 0.875rem;
  height: 0.875rem;
  margin-bottom: 0.625rem;
  background: var(--ui-text-highlighted);
  clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
}

.vh-cms-rail-item {
  display: inline-flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: var(--ui-radius);
  font-size: 0.9375rem;
}

.vh-cms-rail-item.is-active {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.vh-cms-rail-end {
  margin-top: auto;
}

.vh-cms-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.vh-cms-header {
  display: flex;
  height: 2.75rem;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.625rem 0 0.75rem;
  white-space: nowrap;
}

.vh-cms-trail {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  color: var(--ui-text-muted);
}

/* The pill keeps the width of its longest label, so a new label never pushes Publish. */
.vh-cms-status {
  display: inline-flex;
  min-width: 6.25rem;
  height: 1.375rem;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  margin-left: auto;
  border-radius: 999px;
  background: var(--ui-bg-elevated);
  padding: 0 0.5rem;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
  transition: background-color 200ms ease, color 200ms ease;
}

.vh-cms-status[data-tone="warning"] {
  background: color-mix(in oklch, var(--vh-cms-draft) 14%, transparent);
  color: var(--ui-text);
}

.vh-cms-status[data-tone="success"] {
  background: color-mix(in oklch, var(--vh-cms-live) 16%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-cms-dot {
  width: 0.375rem;
  height: 0.375rem;
  flex: none;
  border-radius: 999px;
  background: var(--ui-text-dimmed);
  transition: background-color 200ms ease, transform 200ms var(--vh-cms-out);
}

.vh-cms-status[data-tone="warning"] .vh-cms-dot {
  background: var(--vh-cms-draft);
}

.vh-cms-status[data-tone="success"] .vh-cms-dot {
  background: var(--vh-cms-live);
}

.vh-cms-demo[data-phase="saving"] .vh-cms-dot {
  transform: scale(1.35);
}

.vh-cms-publish {
  position: relative;
  display: inline-grid;
  height: 1.75rem;
  place-items: center;
  border-radius: var(--ui-radius);
  background: var(--ui-text-highlighted);
  padding: 0 0.75rem;
  color: var(--ui-bg);
  font-weight: 500;
  transition: transform 150ms ease-out, background-color 200ms ease, color 200ms ease;
}

.vh-cms-publish > * {
  grid-area: 1 / 1;
}

.vh-cms-publish.is-pressed {
  transform: scale(0.96);
}

/* With nothing new to publish the button stays quiet. The first key wakes it. */
.vh-cms-publish.is-done {
  background: var(--ui-bg-accented);
  color: var(--ui-text-muted);
}

.vh-cms-publish-label {
  transition: opacity 150ms ease, transform 200ms var(--vh-cms-out);
}

.vh-cms-spinner {
  width: 0.75rem;
  height: 0.75rem;
  border: 1.5px solid currentcolor;
  border-right-color: transparent;
  border-radius: 999px;
  opacity: 0;
  transform: scale(0.5);
  transition: opacity 150ms ease, transform 200ms var(--vh-cms-out);
}

.vh-cms-publish.is-busy .vh-cms-publish-label {
  opacity: 0;
  transform: scale(0.8);
}

.vh-cms-publish.is-busy .vh-cms-spinner {
  opacity: 1;
  transform: scale(1);
  animation: vh-cms-spin 700ms linear infinite;
}

@keyframes vh-cms-spin {
  to { rotate: 360deg; }
}

/* The pointer leaves the end of the new sentence and glides onto Publish. */
.vh-cms-pointer {
  position: absolute;
  top: 55%;
  left: 40%;
  width: 0.875rem;
  fill: var(--ui-text-highlighted);
  stroke: var(--ui-bg);
  stroke-width: 1.2;
  opacity: 0;
  pointer-events: none;
  transform: translate(-11rem, 14rem);
  transition: transform 750ms var(--vh-cms-move), opacity 200ms ease;
}

.vh-cms-pointer.is-near {
  opacity: 1;
  transform: none;
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
  text-wrap: balance;
}

.vh-cms-fields {
  display: grid;
  grid-template-columns: 3.25rem 1fr;
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
  border-radius: 999px;
  background: var(--ui-bg-elevated);
  padding: 0.0625rem 0.4375rem;
}

.vh-cms-body {
  min-height: 2.8em;
  margin: 0 0 0.625rem;
  text-wrap: pretty;
}

.vh-cms-typed {
  position: relative;
  transition: opacity 300ms ease;
}

/* The same mark as on the draft preview: this sentence is not live yet. */
.vh-cms-typed::before {
  position: absolute;
  inset: 0.125rem auto 0.125rem -0.625rem;
  width: 2px;
  border-radius: 1px;
  background: var(--vh-cms-draft);
  content: "";
  opacity: 0;
  transition: opacity 250ms ease;
}

.vh-cms-typed.is-changed::before {
  opacity: 1;
}

.vh-cms-typed.is-fading {
  opacity: 0;
}

/* The caret steps on and off like a real one, with no fade. */
.vh-cms-caret {
  display: inline-block;
  width: 1.5px;
  height: 1.1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--ui-text-highlighted);
  opacity: 0;
}

.vh-cms-caret.is-on {
  opacity: 1;
}

.vh-cms-site {
  display: flex;
  min-width: 0;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.75rem 0 0 0.75rem;
}

/* The browser runs off the right and bottom edges, so it reads as a page that goes on. */
.vh-cms-browser {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--ui-radius) 0 0 0;
  background: var(--ui-bg);
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 0.06),
    0 2px 8px -2px rgb(0 0 0 / 0.08);
}

:root.dark .vh-cms-browser {
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
}

.vh-cms-address {
  display: flex;
  height: 1.75rem;
  flex: none;
  align-items: center;
  gap: 0.625rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  padding: 0 0.625rem;
  color: var(--ui-text-muted);
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
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  white-space: nowrap;
}

.vh-cms-url > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.vh-cms-lock {
  width: 0.625rem;
  height: 0.625rem;
  flex: none;
}

/* Both banner states are always there, one over the other, so the swap is a cross-fade and the page never moves. */
.vh-cms-banner {
  display: grid;
  height: 1.625rem;
  flex: none;
  align-items: center;
  background: color-mix(in oklch, var(--vh-cms-draft) 13%, var(--ui-bg));
  padding: 0 0.625rem;
  font-size: 0.625rem;
  transition: background-color 250ms ease;
}

.vh-cms-banner[data-state="live"] {
  background: color-mix(in oklch, var(--vh-cms-live) 13%, var(--ui-bg));
}

.vh-cms-banner-state {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.375rem;
  grid-area: 1 / 1;
  overflow: hidden;
  white-space: nowrap;
  color: var(--ui-text);
  transition: opacity 250ms var(--vh-cms-out), transform 250ms var(--vh-cms-out), filter 250ms var(--vh-cms-out);
}

.vh-cms-banner-state b {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}

.vh-cms-banner-state > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.vh-cms-banner-icon {
  width: 0.75rem;
  height: 0.75rem;
  flex: none;
}

.is-draft .vh-cms-banner-icon {
  color: var(--vh-cms-draft);
}

.is-live .vh-cms-banner-icon {
  color: var(--vh-cms-live);
}

.vh-cms-banner[data-state="draft"] .is-live,
.vh-cms-banner[data-state="live"] .is-draft {
  opacity: 0;
  filter: blur(2px);
}

.vh-cms-banner[data-state="draft"] .is-live {
  transform: translateY(0.375rem);
}

.vh-cms-banner[data-state="live"] .is-draft {
  transform: translateY(-0.375rem);
}

.vh-cms-site-page {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: 0 0.875rem;
}

.vh-cms-site-nav {
  display: flex;
  height: 2rem;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--ui-border);
  margin-bottom: 0.75rem;
  font-size: 0.625rem;
}

.vh-cms-site-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  color: var(--ui-text-highlighted);
  font-family: ui-serif, Georgia, serif;
  font-size: 0.75rem;
  font-weight: 700;
}

.vh-cms-site-brand i {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--vh-cms-accent);
}

.vh-cms-site-links {
  display: inline-flex;
  gap: 0.625rem;
  color: var(--ui-text-muted);
}

.vh-cms-site-links .is-current {
  color: var(--ui-text-highlighted);
}

.vh-cms-cover {
  height: 3.75rem;
  overflow: hidden;
  margin-bottom: 0.75rem;
  border-radius: calc(var(--ui-radius) * 0.75);
  background: var(--vh-cms-cover);
}

.vh-cms-cover svg {
  display: block;
  width: 100%;
  height: 100%;
}

.vh-cms-cover-sun {
  fill: color-mix(in oklch, var(--vh-cms-accent) 70%, var(--vh-cms-cover));
}

.vh-cms-cover-far {
  fill: color-mix(in oklch, var(--vh-cms-accent) 30%, var(--vh-cms-cover));
}

.vh-cms-cover-near {
  fill: color-mix(in oklch, var(--vh-cms-accent) 55%, var(--vh-cms-cover));
}

.vh-cms-site-kicker {
  display: flex;
  gap: 0.5rem;
  margin: 0 0 0.3125rem;
  color: var(--vh-cms-accent);
  font-size: 0.5625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-cms-site-kicker span {
  color: var(--ui-text-dimmed);
  font-weight: 500;
}

.vh-cms-site-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-family: ui-serif, Georgia, serif;
  font-size: 1.0625rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.15;
  text-wrap: balance;
}

.vh-cms-site-byline {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0.5rem 0 0.75rem;
  color: var(--ui-text);
  font-size: 0.625rem;
  font-weight: 500;
}

.vh-cms-avatar {
  display: inline-grid;
  width: 1.125rem;
  height: 1.125rem;
  place-items: center;
  border-radius: 999px;
  background: var(--vh-cms-cover);
  color: var(--vh-cms-accent);
  font-size: 0.4375rem;
  font-weight: 700;
}

.vh-cms-site-read {
  color: var(--ui-text-dimmed);
  font-weight: 400;
}

.vh-cms-site-read::before {
  content: "·";
  margin-right: 0.375rem;
}

.vh-cms-site-body {
  margin: 0 0 0.5rem;
  font-family: ui-serif, Georgia, serif;
  font-size: 0.6875rem;
  line-height: 1.55;
  text-wrap: pretty;
}

/*
 * The new sentence takes its space from the start, so the page below it never moves. A saved draft shows with a
 * draft mark in the margin. On publish the mark turns to the live color for a moment, then goes.
 */
.vh-cms-site-new {
  position: relative;
  opacity: 0;
  transform: translateY(0.25rem);
  transition: opacity 250ms var(--vh-cms-out), transform 250ms var(--vh-cms-out);
}

.vh-cms-site-new::before {
  position: absolute;
  inset: 0.125rem auto 0.125rem -0.5rem;
  width: 2px;
  border-radius: 1px;
  background: var(--vh-cms-draft);
  content: "";
  transition: background-color 250ms ease, opacity 400ms ease;
}

.vh-cms-site-new[data-state="draft"],
.vh-cms-site-new[data-state="live"] {
  opacity: 1;
  transform: none;
}

.vh-cms-site-new[data-state="live"]::before {
  background: var(--vh-cms-live);
  opacity: 0;
}

.vh-cms-site-new[data-state="live"].is-fresh::before {
  opacity: 1;
}

/* The button sits over the rail, away from the page. */
.vh-cms-toggle {
  position: absolute;
  bottom: 0.5rem;
  left: 0.5rem;
  display: inline-flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: var(--ui-radius);
  color: var(--ui-text-muted);
  opacity: 0;
  transition: opacity 150ms ease, background-color 150ms ease, color 150ms ease;
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
    grid-template-rows: minmax(0, 1fr) minmax(0, 1.3fr);
    aspect-ratio: 3 / 4;
  }

  .vh-cms-rail,
  .vh-cms-fields,
  .vh-cms-cover {
    display: none;
  }

  .vh-cms-title {
    margin-bottom: 0.875rem;
  }

  .vh-cms-site {
    border-top: 1px solid var(--ui-border);
    border-left: 0;
  }

  .vh-cms-pointer {
    transform: translate(1rem, 8rem);
  }

  /* With no rail, the button moves to the corner of the page and gets its own surface. */
  .vh-cms-toggle {
    right: 0.5rem;
    left: auto;
    background: var(--ui-bg);
    box-shadow: 0 0 0 1px var(--ui-border);
  }
}

@media (prefers-reduced-motion: reduce) {
  .vh-cms-demo * {
    transition: none !important;
    animation: none !important;
  }
}
</style>
