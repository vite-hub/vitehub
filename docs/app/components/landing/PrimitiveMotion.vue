<script setup lang="ts">
import { primitiveScenes, renderPrimitiveScene } from "./primitive-scenes";

const props = withDefaults(defineProps<{
  name: string;
  /** Keep the scene running. Consumers may pause it while it is off screen. */
  play?: boolean;
  /** Start position in the loop, from 0 to 1, so neighboring scenes do not move in step. */
  offset?: number;
}>(), {
  play: true,
  offset: 0,
});

const id = useId();
const cycle = computed(() => primitiveScenes[props.name]?.cycle ?? 5000);
// The README export renders the same markup, so both show the same pixels.
const markup = computed(() => renderPrimitiveScene(props.name, `vh-${id}`));
</script>

<!--
  Every keyframe set starts and ends on the same frame, so loops never jump.
  Moves use step timing with one step per pixel, so shapes stay on the 2 unit pixel grid.
  Resting shapes start at x=0, the view box edge, so each scene aligns with the tile text.
-->
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- The markup comes from the static scenes in primitive-scenes.ts. -->
  <svg
    viewBox="0 0 58 40"
    preserveAspectRatio="xMinYMid meet"
    fill="currentColor"
    shape-rendering="crispEdges"
    class="primitive-motion size-full"
    :class="{ 'is-playing': props.play }"
    :style="{ '--cycle': `${cycle}ms`, '--scene-delay': `${-props.offset * cycle}ms` }"
    aria-hidden="true"
    v-html="markup"
  />
</template>

<!-- Not scoped: the scene markup comes from v-html. Every selector starts with .primitive-motion. -->
<style>
.primitive-motion {
  overflow: visible;
}

.primitive-motion .line,
.primitive-motion .job,
.primitive-motion .command,
.primitive-motion .budget {
  opacity: 0.55;
}
.primitive-motion .link {
  opacity: 0.4;
}
.primitive-motion .soft {
  opacity: 0.35;
}
.primitive-motion .ink,
.primitive-motion .token,
.primitive-motion .pointer {
  opacity: 0.85;
}
/* Cards hide the cards behind them, so their outline mixes with the tile background instead of using opacity. */
.primitive-motion .card {
  fill: color-mix(in srgb, currentColor 55%, var(--tile-bg, var(--ui-bg)));
}
.primitive-motion .card-fill {
  fill: var(--tile-bg, var(--ui-bg));
}
.primitive-motion .lens {
  fill: var(--tile-bg, var(--ui-bg));
  fill-opacity: 0.6;
}
.primitive-motion .token,
.primitive-motion .band,
.primitive-motion .ghost,
.primitive-motion .q-in,
.primitive-motion .blob-next {
  opacity: 0;
}

.primitive-motion .a {
  animation-duration: var(--cycle);
  animation-delay: var(--scene-delay);
  animation-iteration-count: infinite;
  animation-fill-mode: both;
  animation-timing-function: steps(3);
}
/* Loops run only while the scene is on screen. */
.primitive-motion:not(.is-playing) .a {
  animation-play-state: paused;
}

/* Bars grow from their left pixel. Step timing grows them one pixel at a time. */
.primitive-motion .wf-rail-1,
.primitive-motion .wf-rail-2,
.primitive-motion .sh-command,
.primitive-motion .ws-file,
.primitive-motion .cms-edit,
.primitive-motion .blob-progress {
  transform-box: fill-box;
  transform-origin: left center;
}
/* Clock hands and carets jump between frames. */
.primitive-motion .sch-hand-1,
.primitive-motion .sch-hand-2,
.primitive-motion .sch-hand-3,
.primitive-motion .sch-hand-4,
.primitive-motion .rt-caret-a,
.primitive-motion .rt-caret-b {
  animation-timing-function: step-end;
}

/* Agent: a message starts the run, and the Agent calls three primitives through its Capabilities. */
.primitive-motion .ag-call { animation-name: ag-call; }
.primitive-motion .ag-run { animation-name: ag-run; }
.primitive-motion .ag-call-1 { animation-name: ag-call-1; }
.primitive-motion .ag-call-2 { animation-name: ag-call-2; }
.primitive-motion .ag-call-3 { animation-name: ag-call-3; }
.primitive-motion .ag-tool-1 { animation-name: ag-tool-1; }
.primitive-motion .ag-tool-2 { animation-name: ag-tool-2; }
.primitive-motion .ag-tool-3 { animation-name: ag-tool-3; }
@keyframes ag-call {
  0%, 4% { opacity: 0; transform: translateX(0); }
  7% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(3); }
  16% { opacity: 0.85; transform: translateX(6px); }
  19%, 100% { opacity: 0; transform: translateX(6px); }
}
@keyframes ag-run {
  0%, 17% { opacity: 0.35; }
  21%, 88% { opacity: 0.85; }
  96%, 100% { opacity: 0.35; }
}
@keyframes ag-call-1 {
  0%, 22% { opacity: 0; transform: translate(0, 0); }
  25% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(4); }
  36% { opacity: 0.85; transform: translate(8px, -8px); }
  39%, 100% { opacity: 0; transform: translate(8px, -8px); }
}
@keyframes ag-tool-1 {
  0%, 35% { opacity: 0.35; }
  40%, 46% { opacity: 0.85; }
  56%, 100% { opacity: 0.35; }
}
@keyframes ag-call-2 {
  0%, 44% { opacity: 0; transform: translateX(0); }
  47% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(4); }
  58% { opacity: 0.85; transform: translateX(8px); }
  61%, 100% { opacity: 0; transform: translateX(8px); }
}
@keyframes ag-tool-2 {
  0%, 57% { opacity: 0.35; }
  62%, 68% { opacity: 0.85; }
  78%, 100% { opacity: 0.35; }
}
@keyframes ag-call-3 {
  0%, 66% { opacity: 0; transform: translate(0, 0); }
  69% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(4); }
  80% { opacity: 0.85; transform: translate(8px, 8px); }
  83%, 100% { opacity: 0; transform: translate(8px, 8px); }
}
@keyframes ag-tool-3 {
  0%, 79% { opacity: 0.35; }
  84%, 90% { opacity: 0.85; }
  100% { opacity: 0.35; }
}

/* Env: each value is validated in order. */
.primitive-motion .env-check-1 { animation-name: env-check-1; }
.primitive-motion .env-check-2 { animation-name: env-check-2; }
.primitive-motion .env-check-3 { animation-name: env-check-3; }
.primitive-motion .env-value-1 { animation-name: env-value-1; }
.primitive-motion .env-value-2 { animation-name: env-value-2; }
.primitive-motion .env-value-3 { animation-name: env-value-3; }
@keyframes env-check-1 {
  0% { opacity: 0.85; }
  5%, 14% { opacity: 0; }
  22%, 100% { opacity: 0.85; }
}
@keyframes env-check-2 {
  0% { opacity: 0.85; }
  5%, 26% { opacity: 0; }
  34%, 100% { opacity: 0.85; }
}
@keyframes env-check-3 {
  0% { opacity: 0.85; }
  5%, 38% { opacity: 0; }
  46%, 100% { opacity: 0.85; }
}
@keyframes env-value-1 {
  0%, 10% { opacity: 0.35; }
  16% { opacity: 0.75; }
  26%, 100% { opacity: 0.35; }
}
@keyframes env-value-2 {
  0%, 22% { opacity: 0.35; }
  28% { opacity: 0.75; }
  38%, 100% { opacity: 0.35; }
}
@keyframes env-value-3 {
  0%, 34% { opacity: 0.35; }
  40% { opacity: 0.75; }
  50%, 100% { opacity: 0.35; }
}

/* UI: a result reaches the page and its component lights up. */
.primitive-motion .ui-token { animation-name: ui-token; }
.primitive-motion .ui-panel { animation-name: ui-panel; }
@keyframes ui-token {
  0%, 10% { opacity: 0; transform: translateX(0); }
  14% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(4); }
  30% { opacity: 0.85; transform: translateX(-8px); }
  34%, 100% { opacity: 0; transform: translateX(-8px); }
}
@keyframes ui-panel {
  0%, 30% { opacity: 0.35; }
  36%, 60% { opacity: 0.8; }
  72%, 100% { opacity: 0.35; }
}

/* Auth: a credential opens the lock, a session starts, and the lock closes again. */
.primitive-motion .auth-token { animation-name: auth-token; }
.primitive-motion .auth-shackle { animation-name: auth-shackle; }
.primitive-motion .auth-session { animation-name: auth-session; }
@keyframes auth-token {
  0%, 6% { opacity: 0; transform: translateX(0); }
  10% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(8); }
  24% { opacity: 0.85; transform: translateX(-16px); }
  28%, 100% { opacity: 0; transform: translateX(-16px); }
}
@keyframes auth-shackle {
  0%, 26% { transform: translateY(0); animation-timing-function: steps(2); }
  36%, 62% { transform: translateY(-4px); animation-timing-function: steps(2); }
  72%, 100% { transform: translateY(0); }
}
@keyframes auth-session {
  0%, 32% { opacity: 0.35; }
  40%, 64% { opacity: 0.8; }
  76%, 100% { opacity: 0.35; }
}

/* Connections: one app calls several connected accounts, one after another. */
.primitive-motion .conn-call-1 { animation-name: conn-call-1; }
.primitive-motion .conn-call-2 { animation-name: conn-call-2; }
.primitive-motion .conn-call-3 { animation-name: conn-call-3; }
.primitive-motion .conn-service-1 { animation-name: conn-service-1; }
.primitive-motion .conn-service-2 { animation-name: conn-service-2; }
.primitive-motion .conn-service-3 { animation-name: conn-service-3; }
@keyframes conn-call-1 {
  0%, 4% { opacity: 0; transform: translate(0, 0); }
  7% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(4); }
  20% { opacity: 0.85; transform: translate(16px, -8px); }
  23%, 100% { opacity: 0; transform: translate(16px, -8px); }
}
@keyframes conn-service-1 {
  0%, 19% { opacity: 0.35; }
  24%, 30% { opacity: 0.85; }
  40%, 100% { opacity: 0.35; }
}
@keyframes conn-call-3 {
  0%, 36% { opacity: 0; transform: translate(0, 0); }
  39% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(4); }
  52% { opacity: 0.85; transform: translate(16px, 8px); }
  55%, 100% { opacity: 0; transform: translate(16px, 8px); }
}
@keyframes conn-service-3 {
  0%, 51% { opacity: 0.35; }
  56%, 62% { opacity: 0.85; }
  72%, 100% { opacity: 0.35; }
}
@keyframes conn-call-2 {
  0%, 68% { opacity: 0; transform: translateX(0); }
  71% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(10); }
  84% { opacity: 0.85; transform: translateX(20px); }
  87%, 100% { opacity: 0; transform: translateX(20px); }
}
@keyframes conn-service-2 {
  0%, 83% { opacity: 0.35; }
  88%, 94% { opacity: 0.85; }
  100% { opacity: 0.35; }
}

/* Rate Limit: three calls pass the gate and spend the budget, the fourth is refused, and the budget refills. */
.primitive-motion .rl-request { animation-name: rl-request; }
.primitive-motion .rl-gate { animation-name: rl-gate; }
.primitive-motion .rl-budget-1 { animation-name: rl-budget-1; }
.primitive-motion .rl-budget-2 { animation-name: rl-budget-2; }
.primitive-motion .rl-budget-3 { animation-name: rl-budget-3; }
@keyframes rl-request {
  0%, 4% { opacity: 0; transform: translateX(0); }
  6% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(9); }
  13% { opacity: 0.85; transform: translateX(-18px); }
  15%, 18% { opacity: 0; transform: translateX(-18px); }
  18.1% { opacity: 0; transform: translateX(0); }
  20% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(9); }
  27% { opacity: 0.85; transform: translateX(-18px); }
  29%, 32% { opacity: 0; transform: translateX(-18px); }
  32.1% { opacity: 0; transform: translateX(0); }
  34% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(9); }
  41% { opacity: 0.85; transform: translateX(-18px); }
  43%, 46% { opacity: 0; transform: translateX(-18px); }
  46.1% { opacity: 0; transform: translateX(0); }
  48% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(9); }
  55% { opacity: 0.85; transform: translateX(-18px); animation-timing-function: steps(5); }
  63% { opacity: 0.5; transform: translateX(-8px); animation-timing-function: steps(1); }
  68%, 100% { opacity: 0; transform: translateX(-6px); }
}
@keyframes rl-gate {
  0%, 54% { opacity: 0; }
  57% { opacity: 0.85; }
  70%, 100% { opacity: 0; }
}
@keyframes rl-budget-1 {
  0%, 13% { opacity: 0.55; }
  16%, 74% { opacity: 0.12; }
  80%, 100% { opacity: 0.55; }
}
@keyframes rl-budget-2 {
  0%, 27% { opacity: 0.55; }
  30%, 82% { opacity: 0.12; }
  88%, 100% { opacity: 0.55; }
}
@keyframes rl-budget-3 {
  0%, 41% { opacity: 0.55; }
  44%, 90% { opacity: 0.12; }
  96%, 100% { opacity: 0.55; }
}

/* KV: each write pushes the entries up one row of 4 pixels. */
.primitive-motion .kv-strip { animation-name: kv-strip; animation-timing-function: steps(4); }
@keyframes kv-strip {
  0% { transform: translateY(0); }
  33.333% { transform: translateY(-8px); }
  66.667% { transform: translateY(-16px); }
  100% { transform: translateY(-24px); }
}

/* Database: a query arrives, scans to the matching row, and returns it. */
.primitive-motion .db-token { animation-name: db-token; }
.primitive-motion .db-band { animation-name: db-band; }
.primitive-motion .db-match { animation-name: db-match; }
@keyframes db-token {
  0% { opacity: 0; transform: translateX(0); }
  6% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(3); }
  18% { opacity: 0.85; transform: translateX(-6px); }
  22%, 100% { opacity: 0; transform: translateX(-6px); }
}
@keyframes db-band {
  0%, 18% { opacity: 0; transform: translateY(0); }
  22% { opacity: 0.1; transform: translateY(0); animation-timing-function: steps(3); }
  34%, 60% { opacity: 0.1; transform: translateY(6px); }
  70%, 100% { opacity: 0; transform: translateY(6px); }
}
@keyframes db-match {
  0%, 32% { opacity: 0.35; }
  38%, 60% { opacity: 0.85; }
  72%, 100% { opacity: 0.35; }
}

/* Blob: the front upload fills, then the stack moves back and the next upload arrives. */
.primitive-motion .blob-stack { animation-name: blob-stack; }
.primitive-motion .blob-progress { animation-name: blob-progress; }
.primitive-motion .blob-front { animation-name: blob-front; }
.primitive-motion .blob-next { animation-name: blob-next; }
.primitive-motion .blob-last { animation-name: blob-last; }
@keyframes blob-stack {
  0%, 50% { transform: translate(0, 0); animation-timing-function: steps(2); }
  72%, 99.9% { transform: translate(4px, -4px); }
  100% { transform: translate(0, 0); }
}
@keyframes blob-progress {
  0%, 6% { transform: scaleX(0); animation-timing-function: steps(5); }
  44%, 99.9% { transform: scaleX(1); }
  100% { transform: scaleX(0); }
}
@keyframes blob-front {
  0%, 50% { opacity: 1; }
  62%, 99.9% { opacity: 0; }
  100% { opacity: 1; }
}
@keyframes blob-next {
  0%, 50% { opacity: 0; }
  72%, 99.9% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes blob-last {
  0%, 50% { opacity: 1; }
  70%, 99.9% { opacity: 0; }
  100% { opacity: 1; }
}

/* Workspace: the call walks the tree and writes the last file. */
.primitive-motion .ws-token { animation-name: ws-token; }
.primitive-motion .ws-file { animation-name: ws-file; }
@keyframes ws-token {
  0%, 6% { opacity: 0; transform: translate(0, 0); }
  10% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(8); }
  30% { opacity: 0.85; transform: translate(0, 16px); animation-timing-function: steps(3); }
  38% { opacity: 0.85; transform: translate(6px, 16px); }
  42%, 100% { opacity: 0; transform: translate(6px, 16px); }
}
@keyframes ws-file {
  0% { opacity: 0.35; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5% { opacity: 0.35; transform: scaleX(0); }
  38% { transform: scaleX(0); animation-timing-function: steps(13); }
  54%, 100% { opacity: 0.35; transform: scaleX(1); }
}

/* Source: read-only content flows one way into the mounted folder. */
.primitive-motion .src-flow { animation-name: src-flow; }
.primitive-motion .src-flow-late { animation-delay: calc(var(--scene-delay) - var(--cycle) / 2); }
.primitive-motion .src-mount { animation-name: src-mount; }
@keyframes src-flow {
  0% { opacity: 0; transform: translateX(0); }
  12% { opacity: 0.7; transform: translateX(0); animation-timing-function: steps(8); }
  74% { opacity: 0.7; transform: translateX(-16px); }
  86%, 100% { opacity: 0; transform: translateX(-16px); }
}
@keyframes src-mount {
  0%, 26%, 50%, 76%, 100% { opacity: 0.55; }
  34%, 84% { opacity: 1; }
}

/* Content: a search moves over the parsed lines and marks each match. */
.primitive-motion .ct-lens { animation-name: ct-lens; }
.primitive-motion .ct-line-1 { animation-name: ct-line-1; }
.primitive-motion .ct-line-2 { animation-name: ct-line-2; }
.primitive-motion .ct-line-3 { animation-name: ct-line-3; }
@keyframes ct-lens {
  0%, 12% { transform: translateY(0); }
  22%, 34% { transform: translateY(6px); }
  44%, 56% { transform: translateY(12px); }
  66%, 78% { transform: translateY(6px); }
  88%, 100% { transform: translateY(0); }
}
@keyframes ct-line-1 {
  0%, 10% { opacity: 0.75; }
  18%, 84% { opacity: 0.35; }
  92%, 100% { opacity: 0.75; }
}
@keyframes ct-line-2 {
  0%, 18%, 40%, 62%, 84%, 100% { opacity: 0.35; }
  26%, 32%, 70%, 76% { opacity: 0.75; }
}
@keyframes ct-line-3 {
  0%, 40% { opacity: 0.35; }
  48%, 54% { opacity: 0.75; }
  62%, 100% { opacity: 0.35; }
}

/* Queue: jobs advance one slot and the worker takes the first one. */
.primitive-motion .q-belt { animation-name: q-belt; }
.primitive-motion .q-in { animation-name: q-in; }
.primitive-motion .q-out { animation-name: q-out; }
.primitive-motion .q-worker { animation-name: q-worker; }
/* The belt returns to its start on the last frame. The jobs then sit where the moved jobs were. */
@keyframes q-belt {
  0%, 20% { transform: translateX(0); animation-timing-function: steps(6); }
  60%, 99.9% { transform: translateX(12px); }
  100% { transform: translateX(0); }
}
@keyframes q-in {
  0%, 20% { opacity: 0; }
  55%, 99.9% { opacity: 0.55; }
  100% { opacity: 0; }
}
@keyframes q-out {
  0%, 32% { opacity: 0.55; }
  58%, 99.9% { opacity: 0; }
  100% { opacity: 0.55; }
}
@keyframes q-worker {
  0%, 52% { opacity: 0.35; }
  62%, 80% { opacity: 0.85; }
  96%, 100% { opacity: 0.35; }
}

/* Workflow: steps complete in order and the run waits at the middle step. */
.primitive-motion .wf-step-1 { animation-name: wf-step-1; }
.primitive-motion .wf-step-2 { animation-name: wf-step-2; }
.primitive-motion .wf-step-3 { animation-name: wf-step-3; }
.primitive-motion .wf-rail-1 { animation-name: wf-rail-1; }
.primitive-motion .wf-rail-2 { animation-name: wf-rail-2; }
@keyframes wf-step-1 {
  0% { opacity: 0.85; }
  4% { opacity: 0; }
  10%, 100% { opacity: 0.85; }
}
@keyframes wf-rail-1 {
  0% { opacity: 0.85; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5% { opacity: 0.85; transform: scaleX(0); }
  10% { transform: scaleX(0); animation-timing-function: steps(6); }
  24%, 100% { opacity: 0.85; transform: scaleX(1); }
}
@keyframes wf-step-2 {
  0% { opacity: 0.85; }
  4%, 24% { opacity: 0; }
  27%, 44% { opacity: 0.3; }
  48%, 100% { opacity: 0.85; }
}
@keyframes wf-rail-2 {
  0% { opacity: 0.85; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5% { opacity: 0.85; transform: scaleX(0); }
  48% { transform: scaleX(0); animation-timing-function: steps(6); }
  62%, 100% { opacity: 0.85; transform: scaleX(1); }
}
@keyframes wf-step-3 {
  0% { opacity: 0.85; }
  4%, 62% { opacity: 0; }
  66%, 100% { opacity: 0.85; }
}

/* Schedule: the hand turns once in four frames, the run fires, and the next runs move closer. */
.primitive-motion .sch-hand-1 { animation-name: sch-hand-1; }
.primitive-motion .sch-hand-2 { animation-name: sch-hand-2; }
.primitive-motion .sch-hand-3 { animation-name: sch-hand-3; }
.primitive-motion .sch-hand-4 { animation-name: sch-hand-4; }
.primitive-motion .sch-ring { animation-name: sch-ring; }
.primitive-motion .sch-runs { animation-name: sch-runs; }
.primitive-motion .sch-fired { animation-name: sch-fired; }
.primitive-motion .sch-next { animation-name: sch-next; }
@keyframes sch-hand-1 {
  0% { opacity: 0.85; }
  14.5% { opacity: 0; }
  46%, 100% { opacity: 0.85; }
}
@keyframes sch-hand-2 {
  0% { opacity: 0; }
  14.5% { opacity: 0.85; }
  25%, 100% { opacity: 0; }
}
@keyframes sch-hand-3 {
  0% { opacity: 0; }
  25% { opacity: 0.85; }
  35.5%, 100% { opacity: 0; }
}
@keyframes sch-hand-4 {
  0% { opacity: 0; }
  35.5% { opacity: 0.85; }
  46%, 100% { opacity: 0; }
}
@keyframes sch-ring {
  0%, 46% { opacity: 0; }
  49% { opacity: 0.5; }
  68%, 100% { opacity: 0; }
}
@keyframes sch-runs {
  0%, 60% { transform: translateX(0); animation-timing-function: steps(4); }
  84%, 99.9% { transform: translateX(-8px); }
  100% { transform: translateX(0); }
}
@keyframes sch-fired {
  0%, 46% { opacity: 0.35; }
  52%, 62% { opacity: 0.85; }
  78%, 99.9% { opacity: 0; }
  100% { opacity: 0.35; }
}
@keyframes sch-next {
  0%, 62% { opacity: 0; }
  84%, 99.9% { opacity: 0.35; }
  100% { opacity: 0; }
}

/* Sandbox: a call from inside reaches the boundary and stays inside. */
.primitive-motion .sb-process { animation-name: sb-process; }
.primitive-motion .sb-token { animation-name: sb-token; }
.primitive-motion .sb-wall { animation-name: sb-wall; }
@keyframes sb-process {
  0%, 8% { opacity: 0.35; }
  14%, 60% { opacity: 0.85; }
  74%, 100% { opacity: 0.35; }
}
@keyframes sb-token {
  0%, 12% { opacity: 0; transform: translateX(0); }
  16% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(3); }
  30% { opacity: 0.85; transform: translateX(6px); animation-timing-function: steps(2); }
  44% { opacity: 0.5; transform: translateX(2px); }
  50%, 100% { opacity: 0; transform: translateX(0); }
}
@keyframes sb-wall {
  0%, 28% { opacity: 0; }
  32% { opacity: 0.8; }
  56%, 100% { opacity: 0; }
}

/* Browser: the pointer moves to a control, clicks it, and returns. */
.primitive-motion .br-cursor { animation-name: br-cursor; }
.primitive-motion .br-button { animation-name: br-button; }
@keyframes br-cursor {
  0%, 10% { transform: translate(0, 0); animation-timing-function: steps(10); }
  32% { transform: translate(20px, 0); animation-timing-function: step-end; }
  35% { transform: translate(20px, 2px); animation-timing-function: step-end; }
  39%, 60% { transform: translate(20px, 0); animation-timing-function: steps(10); }
  86%, 100% { transform: translate(0, 0); }
}
@keyframes br-button {
  0%, 34% { opacity: 0.35; }
  39%, 58% { opacity: 0.8; }
  70%, 100% { opacity: 0.35; }
}

/* Shell: the command is typed one pixel at a time, then its output appears. */
.primitive-motion .sh-command { animation-name: sh-command; }
.primitive-motion .sh-cursor { animation-name: sh-cursor; }
.primitive-motion .sh-output-1 { animation-name: sh-output-1; }
.primitive-motion .sh-output-2 { animation-name: sh-output-2; }
@keyframes sh-command {
  0% { opacity: 0.55; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5%, 8% { opacity: 0.55; transform: scaleX(0); animation-timing-function: steps(10); }
  36%, 100% { opacity: 0.55; transform: scaleX(1); }
}
@keyframes sh-cursor {
  0% { opacity: 0.85; transform: translateX(0); }
  4% { opacity: 0; transform: translateX(0); }
  5%, 8% { opacity: 0.85; transform: translateX(-20px); animation-timing-function: steps(10); }
  36%, 100% { opacity: 0.85; transform: translateX(0); }
}
@keyframes sh-output-1 {
  0% { opacity: 0.35; transform: translateY(0); }
  4%, 40% { opacity: 0; transform: translateY(2px); }
  48%, 100% { opacity: 0.35; transform: translateY(0); }
}
@keyframes sh-output-2 {
  0% { opacity: 0.35; transform: translateY(0); }
  4%, 46% { opacity: 0; transform: translateY(2px); }
  54%, 100% { opacity: 0.35; transform: translateY(0); }
}

/* Channels: one message travels from the app to a named connector. */
.primitive-motion .ch-token { animation-name: ch-token; }
.primitive-motion .ch-message { animation-name: ch-message; }
@keyframes ch-token {
  0%, 8% { opacity: 0; transform: translateX(0); }
  14% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(15); }
  46% { opacity: 0.85; transform: translateX(30px); }
  52%, 100% { opacity: 0; transform: translateX(30px); }
}
@keyframes ch-message {
  0%, 12% { opacity: 0.35; transform: translateX(0); animation-timing-function: steps(2); }
  32%, 48% { opacity: 0.8; transform: translateX(4px); animation-timing-function: steps(2); }
  68%, 100% { opacity: 0.35; transform: translateX(0); }
}

/* Email: a message leaves the envelope and lands in the inbox as unread. */
.primitive-motion .mail-token { animation-name: mail-token; }
.primitive-motion .mail-unread { animation-name: mail-unread; }
@keyframes mail-token {
  0%, 6% { opacity: 0; transform: translateX(0); }
  12% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(6); }
  38% { opacity: 0.85; transform: translateX(12px); }
  42%, 100% { opacity: 0; transform: translateX(12px); }
}
@keyframes mail-unread {
  0%, 40% { opacity: 0; }
  46%, 80% { opacity: 0.85; }
  92%, 100% { opacity: 0; }
}

/* Realtime: two collaborators jump between lines of the same document. */
.primitive-motion .rt-caret-a { animation-name: rt-caret-a; }
.primitive-motion .rt-caret-b { animation-name: rt-caret-b; }
@keyframes rt-caret-a {
  0%, 18% { transform: translate(0, 0); }
  30%, 58% { transform: translate(-2px, 12px); }
  70%, 100% { transform: translate(0, 0); }
}
@keyframes rt-caret-b {
  0%, 40% { transform: translate(0, 0); }
  52%, 80% { transform: translate(6px, -12px); }
  92%, 100% { transform: translate(0, 0); }
}

/* AI Gateways: two model requests enter the gateway, and it routes each one to the provider. */
.primitive-motion .gw-in-1 { animation-name: gw-in-1; }
.primitive-motion .gw-in-2 { animation-name: gw-in-2; }
.primitive-motion .gw-out { animation-name: gw-out; }
.primitive-motion .gw-route { animation-name: gw-route; }
.primitive-motion .gw-model { animation-name: gw-model; }
@keyframes gw-in-1 {
  0%, 4% { opacity: 0; transform: translate(0, 0); }
  7% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(4); }
  18% { opacity: 0.85; transform: translate(8px, 8px); }
  21%, 100% { opacity: 0; transform: translate(8px, 8px); }
}
@keyframes gw-in-2 {
  0%, 50% { opacity: 0; transform: translate(0, 0); }
  53% { opacity: 0.85; transform: translate(0, 0); animation-timing-function: steps(4); }
  64% { opacity: 0.85; transform: translate(8px, -8px); }
  67%, 100% { opacity: 0; transform: translate(8px, -8px); }
}
@keyframes gw-out {
  0%, 22% { opacity: 0; transform: translateX(0); }
  25% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(5); }
  36% { opacity: 0.85; transform: translateX(10px); }
  39%, 68% { opacity: 0; transform: translateX(10px); }
  68.1% { opacity: 0; transform: translateX(0); }
  71% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(5); }
  82% { opacity: 0.85; transform: translateX(10px); }
  85%, 100% { opacity: 0; transform: translateX(10px); }
}
@keyframes gw-route {
  0%, 17% { opacity: 0.35; }
  20%, 26% { opacity: 0.85; }
  32%, 63% { opacity: 0.35; }
  66%, 72% { opacity: 0.85; }
  78%, 100% { opacity: 0.35; }
}
@keyframes gw-model {
  0%, 35% { opacity: 0.35; }
  40%, 46% { opacity: 0.85; }
  52%, 81% { opacity: 0.35; }
  86%, 92% { opacity: 0.85; }
  100% { opacity: 0.35; }
}

/* CMS: an editor changes a line, and the change is published to the page. */
.primitive-motion .cms-edit { animation-name: cms-edit; }
.primitive-motion .cms-token { animation-name: cms-token; }
.primitive-motion .cms-page { animation-name: cms-page; }
@keyframes cms-edit {
  0%, 6% { opacity: 0.35; transform: scaleX(1); }
  8% { opacity: 0.85; transform: scaleX(0); animation-timing-function: steps(9); }
  30%, 70% { opacity: 0.85; transform: scaleX(1); }
  80%, 100% { opacity: 0.35; transform: scaleX(1); }
}
@keyframes cms-token {
  0%, 32% { opacity: 0; transform: translateX(0); }
  36% { opacity: 0.85; transform: translateX(0); animation-timing-function: steps(4); }
  48% { opacity: 0.85; transform: translateX(8px); }
  52%, 100% { opacity: 0; transform: translateX(8px); }
}
@keyframes cms-page {
  0%, 48% { opacity: 0.35; }
  54%, 76% { opacity: 0.85; }
  86%, 100% { opacity: 0.35; }
}

/* Comments: a reviewer marks a line of the live page and pins a comment to it. */
.primitive-motion .cm-mark { animation-name: cm-mark; }
.primitive-motion .cm-bubble { animation-name: cm-bubble; }
@keyframes cm-mark {
  0%, 10% { opacity: 0.35; }
  16%, 80% { opacity: 0.85; }
  90%, 100% { opacity: 0.35; }
}
@keyframes cm-bubble {
  0%, 18% { opacity: 0; transform: translateY(2px); animation-timing-function: steps(1); }
  24%, 80% { opacity: 1; transform: translateY(0); }
  90%, 100% { opacity: 0; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .primitive-motion .a {
    animation: none;
  }
}
</style>
