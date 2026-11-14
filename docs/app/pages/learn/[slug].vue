<script setup lang="ts">
import { usePlaygroundDevice } from "@vite-hub/ui/workspace";
import { runnableTutorials } from "#build/runnable-tutorials.mjs";
import TutorialCodePre from "~/components/tutorial/TutorialCodePre.vue";
import { frameworkNodes, splitTutorialDocument } from "~/utils/runnable-tutorial";
import { tutorialActionsKey } from "~/utils/tutorial-actions";

import type { DocsPageResponse } from "@vite-hub/docs";
import type { TutorialActions } from "~/utils/tutorial-actions";

// The lesson is the docs page of the tutorial, so the prose has one source. This page adds the live workspace.
// The docs sidebar starts as a narrow strip, so the workspace gets the width, and the reader can open it.
definePageMeta({ layout: "docs", sidebar: "collapsed" });

const route = useRoute();
const router = useRouter();
const { site } = useDocsConfig();
const tutorial = runnableTutorials.find(candidate => candidate.slug === route.params.slug);
if (!tutorial) throw createError({ statusCode: 404, statusMessage: "Tutorial not found", fatal: true });

const { data } = await useFetch<DocsPageResponse>(`/api/_docs/page${tutorial.page}.json`, { key: `docs:${tutorial.page}` });
if (!data.value) throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
// The workspace is a Vite app, so the lesson shows the Vite tab of every framework tabs block.
const lesson = splitTutorialDocument(frameworkNodes(data.value.document.nodes, "Vite"));
const total = tutorial.steps.length;

useSeoMeta({ title: tutorial.title, ogTitle: tutorial.title, description: tutorial.description, ogDescription: tutorial.description });
// The docs page holds the same prose, so search engines index that one.
useHead({ link: [{ rel: "canonical", href: `${site.url}${tutorial.page}` }] });

// `?step=2` opens step 2, so a reader can share the step they are on.
const step = computed({
  get: () => {
    const value = Number(route.query.step);
    return Number.isInteger(value) && value >= 1 && value <= total ? value - 1 : 0;
  },
  set: value => void router.replace({ query: { ...route.query, step: value === 0 ? undefined : String(value + 1) } }),
});
const lessonColumn = useTemplateRef<HTMLElement>("lessonColumn");
watch(step, () => lessonColumn.value?.scrollTo({ top: 0 }));
const nodes = computed(() => [
  ...step.value === 0 ? lesson.intro : [],
  ...lesson.steps[step.value] ? [lesson.steps[step.value]!] : [],
  ...step.value === total - 1 ? lesson.outro : [],
]);

// The workspace gates itself by device. The page only places it: next to the lesson on a desktop that can run it,
// else in the lesson column. Before mount both places render, and CSS shows the one that fits the width.
const { device, supported } = usePlaygroundDevice();
const opened = ref(false);
const side = computed(() => device.value === "pending" || (device.value === "desktop" && supported.value === true));
const inline = computed(() => device.value !== "desktop" || supported.value === false);
const twoColumns = computed(() => device.value === "desktop" && supported.value === true);

const selected = ref(Object.keys(tutorial.steps[step.value]?.files ?? {})[0] ?? "vite.config.ts");
watch(step, (index) => {
  const first = Object.keys(tutorial.steps[index]?.files ?? {})[0];
  if (first) selected.value = first;
});

const actions = reactive<TutorialActions>({
  available: false,
  running: false,
  paths: [],
  show: () => {},
  run: async () => "",
});
// On a tablet, "Show in editor" opens the workspace first.
const lessonActions = reactive({
  available: computed(() => actions.available || (supported.value === true && device.value === "tablet")),
  running: computed(() => actions.running),
  // Every file of the app in any step, so a block can open a file that its step creates.
  paths: [...new Set([...Object.keys(tutorial.files), ...tutorial.steps.flatMap(item => Object.keys(item.files))])],
  show(path: string) {
    opened.value = true;
    if (actions.available) actions.show(path);
    else selected.value = path;
  },
  run: (command: string) => actions.run(command),
});
provide(tutorialActionsKey, lessonActions);

// The lesson column width in percent. The divider drags it and the arrow keys move it.
const split = ref(40);
const splitKey = "vitehub:tutorial:split";
onMounted(() => {
  const saved = Number(localStorage.getItem(splitKey));
  if (saved >= 25 && saved <= 60) split.value = saved;
});
function setSplit(value: number) {
  split.value = Math.round(Math.min(60, Math.max(25, value)));
  try { localStorage.setItem(splitKey, String(split.value)); }
  catch { /* The width still applies on this page. */ }
}
function drag(event: PointerEvent) {
  const handle = event.currentTarget;
  const container = handle instanceof HTMLElement ? handle.parentElement : null;
  if (!container || !(handle instanceof HTMLElement) || event.button !== 0) return;
  event.preventDefault();
  // Pointer capture keeps the drag going over the preview frame.
  handle.setPointerCapture(event.pointerId);
  const rect = container.getBoundingClientRect();
  const move = (next: PointerEvent) => setSplit(((next.clientX - rect.left) / rect.width) * 100);
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
}
function key(event: KeyboardEvent) {
  if (event.key === "ArrowLeft") setSplit(split.value - 5);
  else if (event.key === "ArrowRight") setSplit(split.value + 5);
  else return;
  event.preventDefault();
}

</script>

<template>
  <div
    class="vh-run"
    :class="{ 'has-workspace': twoColumns, 'is-unsupported': supported === false }"
    :style="{ '--vh-run-lesson': `${split}%` }"
  >
    <div ref="lessonColumn" class="vh-run-lesson">
      <header class="vh-run-step">
        <p class="min-w-0 flex-1 truncate text-sm">
          <span class="text-muted">Step {{ step + 1 }} of {{ total }} · </span>
          <span class="font-medium text-highlighted">{{ tutorial.steps[step]?.title }}</span>
        </p>
        <UButton variant="outline" icon="i-lucide-arrow-left" label="Prev" :disabled="step === 0" @click="step = step - 1" />
        <UButton v-if="step < total - 1" trailing-icon="i-lucide-arrow-right" label="Next" @click="step = step + 1" />
      </header>

      <div class="vh-run-prose">
        <p class="text-sm text-muted">
          <NuxtLink to="/learn" class="hover:text-highlighted">Learn</NuxtLink>
          /
          <NuxtLink :to="tutorial.page" class="hover:text-highlighted">Read in the docs</NuxtLink>
        </p>
        <h1 v-if="step === 0" class="mt-4 text-balance text-3xl font-semibold text-highlighted">{{ tutorial.title }}</h1>

        <div v-if="inline" class="vh-run-inline" :class="{ 'is-open': opened }">
          <TutorialWorkspace v-model:open="opened" v-model:selected="selected" :tutorial="tutorial" :step="step" :actions="actions" />
        </div>

        <!-- One step shows at a time, so its heading counts on from the steps before it. -->
        <UPageBody prose class="docs-content docs-tutorial-content !px-0 !pb-0" :style="{ counterReset: `tutorial-step ${step}` }">
          <DocsMarkdown :key="step" :document="{ nodes, toc: [] }" :components="{ pre: TutorialCodePre }" />
        </UPageBody>

        <nav class="vh-run-footer" aria-label="Steps">
          <UButton variant="outline" icon="i-lucide-arrow-left" label="Prev" :disabled="step === 0" @click="step = step - 1" />
          <UButton v-if="step < total - 1" trailing-icon="i-lucide-arrow-right" :label="`Next: ${tutorial.steps[step + 1]?.title}`" @click="step = step + 1" />
          <UButton v-else variant="outline" to="/learn" label="Back to Learn" />
        </nav>
      </div>
    </div>

    <template v-if="side">
      <div
        v-if="twoColumns"
        class="vh-run-divider"
        role="separator"
        aria-label="Resize lesson"
        aria-orientation="vertical"
        :aria-valuenow="split"
        aria-valuemin="25"
        aria-valuemax="60"
        tabindex="0"
        @pointerdown="drag"
        @keydown="key"
      />
      <div class="vh-run-workspace">
        <TutorialWorkspace v-model:selected="selected" :tutorial="tutorial" :step="step" :actions="actions" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.vh-run {
  display: flex;
  flex-direction: column;
}

/* As tall as the workspace toolbar, so both columns start on one line. */
.vh-run-step {
  position: sticky;
  z-index: 5;
  top: var(--ui-header-height);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.75rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
  padding: 0 0.5rem 0 1rem;
}

.vh-run-prose {
  width: 100%;
  max-width: calc(65ch + 2rem);
  margin-inline: auto;
  padding: 1.5rem 1rem 4rem;
}

.vh-run-prose :deep(.docs-content) {
  max-width: 65ch;
}

.vh-run-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 2.5rem;
  border-top: 1px solid var(--ui-border);
  padding-top: 1.5rem;
}

/* Tablets: the workspace opens in the lesson column. */
.vh-run-inline.is-open {
  height: 75dvh;
  margin-top: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  overflow: hidden;
}

/* The column beside the lesson shows from desktop widths on. Before mount, the lesson column holds no placeholder. */
.vh-run-workspace,
.vh-run-inline :deep(.vh-pc-placeholder) {
  display: none !important;
}

/* Desktops: the lesson and the workspace side by side, each as tall as the viewport under the header. */
@media (min-width: 64rem) {
  .vh-run {
    height: calc(100dvh - var(--ui-header-height));
    flex-direction: row;
  }

  .vh-run-lesson {
    flex: 0 0 var(--vh-run-lesson);
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .vh-run-step {
    top: 0;
  }

  .vh-run.is-unsupported .vh-run-lesson {
    flex-basis: 100%;
  }

  .vh-run-workspace {
    display: flex !important;
    flex: 1 1 0;
    flex-direction: column;
    min-width: 0;
  }

  /* Before mount the workspace column has no divider, so its edge draws the line. */
  .vh-run:not(.has-workspace) .vh-run-workspace {
    border-left: 1px solid var(--ui-border);
  }
}

/* A 1px line with a wider hit area, the same as the dividers inside the workspace. */
.vh-run-divider {
  position: relative;
  z-index: 1;
  flex: 0 0 1px;
  background: var(--ui-border);
  cursor: col-resize;
  touch-action: none;
  transition: background-color 150ms;
}

.vh-run-divider::after {
  position: absolute;
  inset: 0 -4px;
  content: "";
}

.vh-run-divider:hover {
  background: var(--ui-border-accented);
}
</style>
