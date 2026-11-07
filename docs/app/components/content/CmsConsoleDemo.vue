<script setup lang="ts">
import { useIntersectionObserver, usePreferredReducedMotion, useRafFn } from "@vueuse/core";
import { cmsDemoCycle, cmsDemoEnd, cmsDemoFrame, cmsDemoSentence } from "~/utils/cms-console-demo";

// `::cms-console-demo` is the CMS hero: the Console document editor beside its page preview. An editor adds an
// update to a published post, the draft saves and the preview shows the draft, they publish, and the preview shows
// the published page with the update.
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

// The rides of the post. The editor shows them as the Markdown list they are, and the site sets them as a schedule.
const rides = [
  { date: "Nov 7", route: "Burke-Gilman to Kenmore", distance: "38 km" },
  { date: "Nov 14", route: "Mercer Island loop", distance: "52 km" },
  { date: "Nov 21", route: "Discovery Park", distance: "24 km" },
];

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
    <div class="vh-cms-window" role="img" aria-label="An editor adds an update to a published post in the ViteHub Console. The draft saves, and the preview beside the editor shows the draft with the new sentence. They click Publish, and the preview shows the published page with the update.">
      <div class="vh-cms-rail" aria-hidden="true">
        <span class="vh-cms-mark" />
        <span class="vh-cms-rail-item is-active"><UIcon name="i-lucide-newspaper" /></span>
        <span class="vh-cms-rail-item"><UIcon name="i-lucide-database" /></span>
        <span class="vh-cms-rail-item vh-cms-rail-end"><UIcon name="i-lucide-settings" /></span>
      </div>

      <!--
        The editor header follows the Console page header on a narrow pane: Back, the title, one status, and Publish.
        As in the Console, Publish shows only while there is something to publish. The demo leaves out the arrow of the
        Console split button, so the header keeps room for the full title and the longest status.
      -->
      <div class="vh-cms-editor" aria-hidden="true">
        <div class="vh-cms-bar">
          <span class="vh-cms-icon-button"><UIcon name="i-lucide-arrow-left" /></span>
          <span class="vh-cms-heading">Autumn rides</span>
          <span class="vh-cms-status" :data-tone="frame.status.tone" :class="{ 'is-pending': frame.status.pending }">
            <span class="vh-cms-dot" />
            {{ frame.status.label }}
          </span>
          <span class="vh-cms-publish-slot">
            <span class="vh-cms-publish" :class="{ 'is-shown': frame.changed, 'is-pressed': frame.pressed, 'is-busy': frame.phase === 'publishing' }">
              <span class="vh-cms-publish-label">Publish</span>
              <span class="vh-cms-spinner" />
            </span>
            <svg class="vh-cms-pointer" :class="{ 'is-near': frame.pointer }" viewBox="0 0 16 20" aria-hidden="true">
              <path d="M1 1v15l4-3.5 2.6 6 2.6-1.1-2.6-5.9H13z" />
            </svg>
          </span>
        </div>

        <div class="vh-cms-page">
          <p class="vh-cms-title">Autumn rides</p>
          <dl class="vh-cms-fields">
            <dt>Date</dt><dd>2026-10-31</dd>
            <dt>Tags</dt><dd><span class="vh-cms-tag">rides</span></dd>
          </dl>
          <p class="vh-cms-body">We ride every Saturday in November. Meet at the north end of the Fremont Bridge, and bring lights.</p>
          <p class="vh-cms-body vh-cms-typed" :class="{ 'is-fading': frame.fading }">
            {{ frame.typed }}<span class="vh-cms-caret" :class="{ 'is-on': frame.caret }" />
          </p>
          <ul class="vh-cms-list">
            <li v-for="ride in rides" :key="ride.date">{{ ride.date }}: {{ ride.route }}, {{ ride.distance }}</li>
          </ul>
        </div>
      </div>

      <!--
        The preview pane follows the Console page preview: a toolbar with the page path and the view, then the site.
      -->
      <div class="vh-cms-preview" aria-hidden="true">
        <div class="vh-cms-bar vh-cms-preview-bar">
          <span class="vh-cms-icon-button" :class="{ 'is-reloading': frame.reloading }"><UIcon name="i-lucide-rotate-cw" /></span>
          <span class="vh-cms-address" :data-view="frame.view">
            <span class="vh-cms-address-icon">
              <UIcon name="i-lucide-eye" class="is-draft" />
              <UIcon name="i-lucide-globe" class="is-published" />
            </span>
            <span class="vh-cms-url">/posts/autumn-rides</span>
            <span class="vh-cms-view">
              <span class="is-draft">Draft</span>
              <span class="is-published">Published</span>
            </span>
          </span>
        </div>

        <div class="vh-cms-site">
          <div class="vh-cms-site-nav">
            <span class="vh-cms-site-name">Eastside Cycling Club</span>
            <span class="vh-cms-site-links"><span>Rides</span><span>About</span></span>
          </div>
          <p class="vh-cms-site-date">October 31, 2026</p>
          <p class="vh-cms-site-title">Autumn rides</p>
          <p class="vh-cms-site-body">We ride every Saturday in November. Meet at the north end of the Fremont Bridge, and bring lights.</p>
          <p class="vh-cms-site-body vh-cms-site-new" :data-state="frame.sentence">{{ cmsDemoSentence }}</p>
          <dl class="vh-cms-site-rides">
            <div v-for="ride in rides" :key="ride.date">
              <dt>{{ ride.date }}</dt>
              <dd>{{ ride.route }}</dd>
              <dd>{{ ride.distance }}</dd>
            </div>
          </dl>
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
 * The status colors are the Console ones: emerald, amber, and sky.
 */
.vh-cms-window {
  --vh-cms-out: cubic-bezier(0.23, 1, 0.32, 1);
  --vh-cms-move: cubic-bezier(0.645, 0.045, 0.355, 1);
  --vh-cms-success: oklch(0.696 0.17 162.48);
  --vh-cms-success-text: oklch(0.596 0.145 163.225);
  --vh-cms-warning: oklch(0.769 0.188 70.08);
  --vh-cms-info-text: oklch(0.588 0.158 241.966);
  --vh-cms-paper: oklch(0.99 0.004 85);
  --vh-cms-ink: oklch(0.25 0.01 60);
  --vh-cms-ink-muted: oklch(0.52 0.012 60);
  --vh-cms-rule: oklch(0.25 0.01 60 / 0.1);

  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1.1fr) minmax(0, 1fr);
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
  --vh-cms-success: oklch(0.765 0.177 163.223);
  --vh-cms-success-text: oklch(0.765 0.177 163.223);
  --vh-cms-warning: oklch(0.828 0.189 84.429);
  --vh-cms-info-text: oklch(0.746 0.16 232.661);
  --vh-cms-paper: oklch(0.19 0.006 70);
  --vh-cms-ink: oklch(0.92 0.008 80);
  --vh-cms-ink-muted: oklch(0.68 0.01 70);
  --vh-cms-rule: oklch(0.92 0.008 80 / 0.1);

  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.09);
}

.vh-cms-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.8125rem 0 0.625rem;
  color: var(--ui-text-dimmed);
}

.vh-cms-mark {
  width: 0.875rem;
  height: 0.875rem;
  margin-bottom: 0.5rem;
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

.vh-cms-editor,
.vh-cms-preview {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

/* Both columns have a header of one height, so their bottom lines meet, as in the Console split view. */
.vh-cms-bar {
  display: flex;
  height: 2.5rem;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.625rem 0 0.4375rem;
  white-space: nowrap;
}

.vh-cms-icon-button {
  display: inline-grid;
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  place-items: center;
  border-radius: calc(var(--ui-radius) * 1.5);
  color: var(--ui-text);
  font-size: 0.875rem;
}

.vh-cms-icon-button.is-reloading > * {
  animation: vh-cms-spin 700ms linear infinite;
}

.vh-cms-heading {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-weight: 600;
  text-overflow: ellipsis;
}

/* A dot and a muted label, as the Console status. Only the dot carries color. */
.vh-cms-status {
  display: inline-flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: 0.3125rem;
  margin-left: 0.25rem;
  color: var(--ui-text-muted);
  font-size: 0.6875rem;
}

.vh-cms-dot {
  width: 0.4375rem;
  height: 0.4375rem;
  flex: none;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
  transition: background-color 200ms ease, box-shadow 200ms ease;
}

.vh-cms-status[data-tone="success"] .vh-cms-dot {
  background: var(--vh-cms-success);
  box-shadow: none;
}

.vh-cms-status[data-tone="warning"] .vh-cms-dot {
  background: var(--vh-cms-warning);
  box-shadow: none;
}

.vh-cms-status.is-pending .vh-cms-dot {
  animation: vh-cms-pulse 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes vh-cms-pulse {
  50% { opacity: 0.4; }
}

/*
 * The Publish button of the Console, solid and small. Its slot keeps its space at the end of the header, so the button
 * can come and go without moving the title or the status. The label and the spinner share one cell, so the button
 * keeps its width while it publishes.
 */
.vh-cms-publish-slot {
  position: relative;
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

.vh-cms-publish {
  display: inline-grid;
  height: 1.5rem;
  place-items: center;
  padding: 0 0.5625rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-text-highlighted);
  color: var(--ui-bg);
  font-size: 0.6875rem;
  font-weight: 500;
  opacity: 0;
  transform: scale(0.96);
  transition: opacity 200ms var(--vh-cms-out), transform 200ms var(--vh-cms-out);
}

.vh-cms-publish.is-shown {
  opacity: 1;
  transform: none;
}

.vh-cms-publish.is-shown.is-pressed {
  transform: scale(0.96);
  transition-duration: 150ms;
}

.vh-cms-publish > * {
  grid-area: 1 / 1;
}

.vh-cms-publish-label {
  transition: opacity 150ms ease, transform 200ms var(--vh-cms-out);
}

.vh-cms-spinner {
  width: 0.6875rem;
  height: 0.6875rem;
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
  left: 1.25rem;
  width: 0.875rem;
  fill: var(--ui-text-highlighted);
  stroke: var(--ui-bg);
  stroke-width: 1.2;
  opacity: 0;
  pointer-events: none;
  transform: translate(-11rem, 13rem);
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
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.2;
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
  color: var(--ui-text-highlighted);
}

.vh-cms-tag {
  border-radius: var(--ui-radius);
  background: var(--ui-bg-elevated);
  padding: 0.0625rem 0.375rem;
  box-shadow: inset 0 0 0 1px var(--ui-border);
  font-size: 0.6875rem;
}

.vh-cms-body {
  min-height: 2.8em;
  margin: 0 0 0.625rem;
  text-wrap: pretty;
}

.vh-cms-typed {
  transition: opacity 300ms ease;
}

.vh-cms-list {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding-left: 1rem;
  list-style: disc;
}

.vh-cms-list ::marker {
  color: var(--ui-text-dimmed);
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

.vh-cms-preview {
  border-left: 1px solid var(--ui-border);
}

.vh-cms-preview-bar {
  padding: 0 0.5rem 0 0.4375rem;
}

.vh-cms-address {
  display: flex;
  height: 1.5rem;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.375rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  background: color-mix(in oklch, var(--ui-bg-elevated) 60%, transparent);
  padding: 0 0.25rem 0 0.5rem;
  box-shadow: inset 0 0 0 1px var(--ui-border);
}

/* The icon and the tag show both views one over the other, so a change of view is a cross-fade in place. */
.vh-cms-address-icon,
.vh-cms-view {
  display: grid;
  flex: none;
}

.vh-cms-address-icon > *,
.vh-cms-view > * {
  grid-area: 1 / 1;
  transition: opacity 200ms ease;
}

.vh-cms-address-icon {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
}

.vh-cms-url {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  text-overflow: ellipsis;
}

.vh-cms-view {
  justify-items: end;
  margin-left: auto;
}

.vh-cms-view > * {
  border-radius: var(--ui-radius);
  padding: 0.1875rem 0.3125rem;
  font-size: 0.5625rem;
  font-weight: 500;
  line-height: 1;
}

.vh-cms-view .is-draft {
  background: color-mix(in oklch, var(--vh-cms-info-text) 10%, transparent);
  color: var(--vh-cms-info-text);
}

.vh-cms-view .is-published {
  background: color-mix(in oklch, var(--vh-cms-success-text) 10%, transparent);
  color: var(--vh-cms-success-text);
}

.vh-cms-address[data-view="draft"] .is-published,
.vh-cms-address[data-view="published"] .is-draft {
  opacity: 0;
}

/*
 * The site is the club's own page, not the Console: its own paper, ink, and a text serif. It fills the pane like the
 * Console preview frame, and it runs off the bottom edge, so it reads as a page that goes on.
 */
.vh-cms-site {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: var(--vh-cms-paper);
  padding: 0 1.125rem;
  color: var(--vh-cms-ink);
}

.vh-cms-site-nav {
  display: flex;
  height: 2.375rem;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.375rem;
  border-bottom: 1px solid var(--vh-cms-rule);
}

.vh-cms-site-name {
  font-family: "Source Serif 4", Georgia, ui-serif, serif;
  font-size: 0.75rem;
  font-weight: 600;
}

.vh-cms-site-links {
  display: inline-flex;
  gap: 0.75rem;
  color: var(--vh-cms-ink-muted);
  font-size: 0.625rem;
}

.vh-cms-site-date {
  margin: 0 0 0.375rem;
  color: var(--vh-cms-ink-muted);
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
}

.vh-cms-site-title {
  margin: 0 0 0.75rem;
  font-family: "Source Serif 4", Georgia, ui-serif, serif;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.15;
  text-wrap: balance;
}

.vh-cms-site-body {
  max-width: 34em;
  margin: 0 0 0.625rem;
  font-family: "Source Serif 4", Georgia, ui-serif, serif;
  font-size: 0.75rem;
  line-height: 1.6;
  text-wrap: pretty;
}

/* The new sentence takes its space from the start, so the page below it never moves. */
.vh-cms-site-new {
  opacity: 0;
  transform: translateY(0.25rem);
  transition: opacity 300ms var(--vh-cms-out), transform 300ms var(--vh-cms-out);
}

.vh-cms-site-new[data-state="draft"],
.vh-cms-site-new[data-state="live"] {
  opacity: 1;
  transform: none;
}

/* The schedule is the one part of the site that is not prose: rows with a hairline, dates and distances in fixed figures. */
.vh-cms-site-rides {
  max-width: 34em;
  margin: 0.25rem 0 0;
  border-top: 1px solid var(--vh-cms-rule);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.vh-cms-site-rides > div {
  display: grid;
  grid-template-columns: 3.25rem minmax(0, 1fr) auto;
  gap: 0.5rem;
  border-bottom: 1px solid var(--vh-cms-rule);
  padding: 0.3125rem 0;
}

.vh-cms-site-rides dt {
  color: var(--vh-cms-ink-muted);
}

.vh-cms-site-rides dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-cms-site-rides dd:last-child {
  color: var(--vh-cms-ink-muted);
  text-align: right;
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

/*
 * On narrow panels the rail goes, as in the Console on a phone, and the preview takes the lower part. The editor keeps
 * only the paragraphs, so the sentence that types in stays the last line it shows.
 */
@container (max-width: 34rem) {
  .vh-cms-window {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1.3fr);
    aspect-ratio: 3 / 4;
  }

  .vh-cms-rail,
  .vh-cms-fields,
  .vh-cms-list {
    display: none;
  }

  .vh-cms-title {
    margin-bottom: 0.875rem;
  }

  .vh-cms-preview {
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
