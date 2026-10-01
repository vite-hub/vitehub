<script setup lang="ts">
const props = withDefaults(defineProps<{
  name: string;
  /** Run one pass. Pause it when the scene is off screen. */
  play?: boolean;
  /** Start position in the loop, from 0 to 1, so neighboring scenes do not move in step. */
  offset?: number;
}>(), {
  play: false,
  offset: 0,
});

// Loop length per scene in milliseconds. Long rests keep the grid quiet.
const cycles: Record<string, number> = {
  kv: 5400,
  connections: 6000,
  queue: 3600,
  sandbox: 4400,
  email: 4400,
  source: 4000,
  realtime: 6000,
  workflow: 5600,
  content: 5600,
};
const cycle = computed(() => cycles[props.name] ?? 5000);
const id = useId();
</script>

<!--
  Each scene loops one call to its primitive and rests on the result between calls.
  Every keyframe set starts and ends on the same frame, so loops never jump.
  The filled dot is the same call token in every scene.
  Resting shapes start at x=6, the viewBox edge, so each icon aligns with the tile text.
-->
<template>
  <svg
    viewBox="6 0 58 40"
    preserveAspectRatio="xMinYMid meet"
    class="primitive-motion size-full"
    :class="{ 'is-playing': props.play }"
    :style="{ '--cycle': `${cycle}ms`, '--scene-delay': `${-props.offset * cycle}ms` }"
    aria-hidden="true"
  >
    <template v-if="name === 'env'">
      <rect x="6" y="10.5" width="10" height="3" rx="1" class="soft" />
      <rect x="6" y="18.5" width="10" height="3" rx="1" class="soft" />
      <rect x="6" y="26.5" width="10" height="3" rx="1" class="soft" />
      <rect x="20" y="10.5" width="20" height="3" rx="1" class="soft a env-value-1" />
      <rect x="20" y="18.5" width="14" height="3" rx="1" class="soft a env-value-2" />
      <rect x="20" y="26.5" width="24" height="3" rx="1" class="soft a env-value-3" />
      <path d="m47 12 2 2 4-4" class="ink-line check a env-check-1" />
      <path d="m47 20 2 2 4-4" class="ink-line check a env-check-2" />
      <path d="m47 28 2 2 4-4" class="ink-line check a env-check-3" />
    </template>

    <template v-else-if="name === 'auth'">
      <defs>
        <clipPath :id="`${id}-shackle`">
          <rect x="0" y="0" width="64" height="18" />
        </clipPath>
      </defs>
      <!-- The right leg continues into the lock body, so the shackle stays attached on that side. -->
      <g :clip-path="`url(#${id}-shackle)`">
        <path d="M10.5 18v-3.5a5.5 5.5 0 0 1 11 0V22" class="ink-line a auth-shackle" />
      </g>
      <rect x="6" y="18" width="20" height="15" rx="2.5" class="line" />
      <circle cx="16" cy="24.5" r="1.75" class="ink" />
      <path d="M16 26v3" class="ink-line" />
      <rect x="36" y="22.5" width="14" height="6" rx="3" class="soft a auth-session" />
      <circle cx="32" cy="24.5" r="2" class="token a auth-token" />
    </template>

    <template v-else-if="name === 'connections'">
      <path d="M18 18 42 9.5M18 20h24M18 22l24 8.5" class="line link" />
      <rect x="6" y="14" width="12" height="12" rx="2.5" class="line" />
      <rect x="10" y="18" width="4" height="4" rx="1" class="soft" />
      <circle cx="46" cy="9" r="4" class="line" />
      <circle cx="46" cy="20" r="4" class="line" />
      <circle cx="46" cy="31" r="4" class="line" />
      <circle cx="46" cy="9" r="1.5" class="soft a conn-service-1" />
      <circle cx="46" cy="20" r="1.5" class="soft a conn-service-2" />
      <circle cx="46" cy="31" r="1.5" class="soft a conn-service-3" />
      <circle cx="18" cy="18" r="1.75" class="token a conn-call-1" />
      <circle cx="18" cy="20" r="1.75" class="token a conn-call-2" />
      <circle cx="18" cy="22" r="1.75" class="token a conn-call-3" />
    </template>

    <template v-else-if="name === 'rate-limit'">
      <rect x="6" y="13" width="4" height="14" rx="1" class="budget a rl-budget-3" />
      <rect x="13" y="13" width="4" height="14" rx="1" class="budget a rl-budget-2" />
      <rect x="20" y="13" width="4" height="14" rx="1" class="budget a rl-budget-1" />
      <path d="M30 11v18" class="line" />
      <path d="M30 11v18" class="ink-line ghost a rl-gate" />
      <circle cx="52" cy="20" r="2" class="token a rl-request" />
    </template>

    <template v-else-if="name === 'kv'">
      <defs>
        <linearGradient :id="`${id}-fade`" x1="0" y1="4" x2="0" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset="0.24" stop-color="#fff" />
          <stop offset="0.76" stop-color="#fff" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <mask :id="`${id}-window`" maskUnits="userSpaceOnUse" x="0" y="4" width="64" height="32">
          <rect x="0" y="4" width="64" height="32" :fill="`url(#${id}-fade)`" />
        </mask>
      </defs>
      <!-- The value widths repeat every three rows, so the strip loops after three entries. -->
      <g :mask="`url(#${id}-window)`">
        <g class="a kv-strip">
          <template v-for="row in 7" :key="row">
            <rect x="6" :y="8 * row - 1" width="8" height="5" rx="1.5" class="soft" />
            <rect x="18" :y="8 * row - 1" :width="[24, 16, 20][(row - 1) % 3]" height="5" rx="1.5" class="soft" />
          </template>
        </g>
      </g>
    </template>

    <template v-else-if="name === 'database'">
      <rect x="6" y="6" width="40" height="28" rx="2" class="line" />
      <path d="M6 13h40M16 13v21" class="line" />
      <rect x="7" y="15" width="38" height="6" class="band a db-band" />
      <rect x="9" y="16.75" width="4" height="2.5" rx="1" class="soft" />
      <rect x="9" y="22.75" width="4" height="2.5" rx="1" class="soft" />
      <rect x="9" y="28.75" width="4" height="2.5" rx="1" class="soft" />
      <rect x="19" y="16.75" width="22" height="2.5" rx="1" class="soft" />
      <rect x="19" y="22.75" width="18" height="2.5" rx="1" class="soft a db-match" />
      <rect x="19" y="28.75" width="24" height="2.5" rx="1" class="soft" />
      <circle cx="54" cy="24" r="2" class="token a db-token" />
    </template>

    <template v-else-if="name === 'blob'">
      <!-- Cards move back one slot per upload. The stack returns to its start on the last frame. -->
      <g class="a blob-stack">
        <rect x="14" y="6" width="16" height="20" rx="2" class="card a blob-last" />
        <rect x="10" y="10" width="16" height="20" rx="2" class="card" />
        <g>
          <rect x="6" y="14" width="16" height="20" rx="2" class="card" />
          <g class="a blob-front">
            <rect x="9" y="18" width="8" height="2" rx="1" class="soft" />
            <rect x="9" y="22" width="6" height="2" rx="1" class="soft" />
            <rect x="9" y="29" width="10" height="1.5" rx="0.75" class="soft" />
            <rect x="9" y="29" width="10" height="1.5" rx="0.75" class="ink a blob-progress" />
          </g>
        </g>
        <g class="a blob-next">
          <rect x="2" y="18" width="16" height="20" rx="2" class="card" />
          <rect x="5" y="22" width="8" height="2" rx="1" class="soft" />
          <rect x="5" y="26" width="6" height="2" rx="1" class="soft" />
          <rect x="5" y="33" width="10" height="1.5" rx="0.75" class="soft" />
        </g>
      </g>
    </template>

    <template v-else-if="name === 'workspace'">
      <rect x="6" y="6" width="7" height="6" rx="1" class="line" />
      <path d="M9.5 12v18M9.5 16H15M9.5 23H15M9.5 30H15" class="line" />
      <rect x="18" y="14.5" width="22" height="3" rx="1" class="soft" />
      <rect x="18" y="21.5" width="16" height="3" rx="1" class="soft" />
      <rect x="18" y="28.5" width="26" height="3" rx="1" class="soft a ws-file" />
      <circle cx="9.5" cy="12" r="2" class="token a ws-token" />
    </template>

    <template v-else-if="name === 'source'">
      <rect x="6" y="6" width="7" height="6" rx="1" class="line" />
      <path d="M9.5 12v18M9.5 16H15M9.5 23H15M9.5 30H15" class="line" />
      <rect x="18" y="14.5" width="12" height="3" rx="1" class="soft" />
      <rect x="18" y="21.5" width="9" height="3" rx="1" class="soft" />
      <path d="M18 27.5h2.5l1 1.25H25V32.5h-7z" class="line a src-mount" />
      <path d="M28 30h12" class="line dashed" />
      <path d="M42 14h10l4 4v16H42zM52 14v4h4" class="line" />
      <rect x="45" y="21" width="8" height="2" rx="1" class="soft" />
      <rect x="45" y="25" width="6" height="2" rx="1" class="soft" />
      <circle cx="42" cy="30" r="1.75" class="token a src-flow" />
      <circle cx="42" cy="30" r="1.75" class="token a src-flow src-flow-late" />
    </template>

    <template v-else-if="name === 'content'">
      <rect x="6" y="6" width="26" height="28" rx="2" class="line" />
      <rect x="10" y="10.5" width="12" height="3" rx="1" class="command" />
      <rect x="10" y="17" width="18" height="2" rx="1" class="soft a ct-line-1" />
      <rect x="10" y="22" width="14" height="2" rx="1" class="soft a ct-line-2" />
      <rect x="10" y="27" width="16" height="2" rx="1" class="soft a ct-line-3" />
      <g class="a ct-lens">
        <circle cx="26" cy="18" r="5" class="ink-line lens" />
        <path d="m29.6 21.6 3.6 3.6" class="ink-line" />
      </g>
    </template>

    <template v-else-if="name === 'queue'">
      <path d="M6 20h40" class="line" />
      <rect x="46" y="13" width="12" height="14" rx="2" class="line" />
      <rect x="49" y="17" width="6" height="6" rx="1" class="soft a q-worker" />
      <g class="a q-belt">
        <circle cx="2" cy="20" r="3" class="job a q-in" />
        <circle cx="14" cy="20" r="3" class="job" />
        <circle cx="26" cy="20" r="3" class="job" />
        <circle cx="38" cy="20" r="3" class="job a q-out" />
      </g>
    </template>

    <template v-else-if="name === 'workflow'">
      <path d="M14 20h14M36 20h14" class="line" />
      <path d="M14 20h14" class="ink-line a wf-rail-1" />
      <path d="M36 20h14" class="ink-line a wf-rail-2" />
      <circle cx="10" cy="20" r="4" class="line" />
      <circle cx="32" cy="20" r="4" class="line" />
      <circle cx="54" cy="20" r="4" class="line" />
      <circle cx="10" cy="20" r="1.75" class="ink a wf-step-1" />
      <circle cx="32" cy="20" r="1.75" class="ink a wf-step-2" />
      <circle cx="54" cy="20" r="1.75" class="ink a wf-step-3" />
    </template>

    <template v-else-if="name === 'schedule'">
      <circle cx="19" cy="20" r="13" class="line" />
      <path d="M19 20l5 3" class="line" />
      <path d="M19 20V11" class="ink-line a sch-hand" />
      <circle cx="19" cy="20" r="1.75" class="ink" />
      <circle cx="19" cy="20" r="13" class="ink-line ghost a sch-ring" />
      <path d="M36 20h22" class="line" />
      <g class="a sch-runs">
        <circle cx="41" cy="20" r="2" class="soft a sch-fired" />
        <circle cx="49" cy="20" r="2" class="soft" />
        <circle cx="57" cy="20" r="2" class="soft" />
        <circle cx="65" cy="20" r="2" class="soft a sch-next" />
      </g>
    </template>

    <template v-else-if="name === 'sandbox'">
      <rect x="6" y="6" width="28" height="28" rx="3" class="line dashed" />
      <path d="M34 9v22" class="ink-line ghost a sb-wall" />
      <rect x="16" y="16" width="8" height="8" rx="1.5" class="soft a sb-process" />
      <circle cx="24" cy="20" r="2" class="token a sb-token" />
      <rect x="44" y="14" width="12" height="12" rx="2" class="soft" />
    </template>

    <template v-else-if="name === 'browser'">
      <rect x="6" y="6" width="48" height="28" rx="2" class="line" />
      <path d="M6 12h48" class="line" />
      <circle cx="9.5" cy="9" r="0.9" class="command" />
      <circle cx="12.5" cy="9" r="0.9" class="command" />
      <circle cx="15.5" cy="9" r="0.9" class="command" />
      <rect x="10" y="16" width="18" height="2" rx="1" class="soft" />
      <rect x="10" y="20" width="12" height="2" rx="1" class="soft" />
      <rect x="34" y="24" width="14" height="6" rx="1.5" class="soft a br-button" />
      <g transform="translate(20 25)">
        <path d="M0 0v7.5l2-1.9 1.6 3.4 1.4-.65-1.6-3.35H7z" class="pointer a br-cursor" />
      </g>
    </template>

    <template v-else-if="name === 'shell'">
      <rect x="6" y="6" width="52" height="28" rx="2.5" class="line" />
      <path d="m11 12.5 3 2.5-3 2.5" class="ink-line" />
      <rect x="17" y="13.5" width="20" height="3" rx="1" class="command a sh-command" />
      <rect x="38" y="12.5" width="2" height="5" class="ink a sh-cursor" />
      <rect x="11" y="22" width="32" height="2.5" rx="1" class="soft a sh-output-1" />
      <rect x="11" y="27" width="22" height="2.5" rx="1" class="soft a sh-output-2" />
    </template>

    <template v-else-if="name === 'email'">
      <rect x="6" y="12" width="20" height="15" rx="1.5" class="line" />
      <path d="m6.75 13 9.25 7 9.25-7" class="line" />
      <path d="M30 20h6" class="line dashed" />
      <path d="M40 14h16v13H40zM40 22h4.5l1.5 2.5h4l1.5-2.5H56" class="line" />
      <circle cx="56" cy="14" r="2" class="ink ghost a mail-unread" />
      <circle cx="26" cy="20" r="2" class="token a mail-token" />
    </template>

    <template v-else-if="name === 'realtime'">
      <rect x="6" y="6" width="36" height="28" rx="2" class="line" />
      <rect x="10" y="11.5" width="26" height="2" rx="1" class="soft" />
      <rect x="10" y="17.5" width="20" height="2" rx="1" class="soft" />
      <rect x="10" y="23.5" width="24" height="2" rx="1" class="soft" />
      <rect x="10" y="29.5" width="14" height="2" rx="1" class="soft" />
      <rect x="36.5" y="10" width="1.25" height="5" class="ink a rt-caret-a" />
      <rect x="24.5" y="28" width="1.25" height="5" class="command a rt-caret-b" />
      <circle cx="50" cy="13" r="2.5" class="ink" />
      <circle cx="50" cy="20" r="2.5" class="command" />
    </template>
  </svg>
</template>

<style scoped>
.primitive-motion {
  --ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  overflow: visible;
}

.line,
.ink-line,
.card {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.line {
  opacity: 0.55;
}
.link {
  opacity: 0.4;
}
.ink-line {
  opacity: 0.85;
}
/* Cards hide the cards behind them, so their stroke carries the tint instead of element opacity. */
.card {
  fill: var(--tile-bg, var(--ui-bg));
  stroke: color-mix(in srgb, currentColor 55%, transparent);
}
.dashed {
  stroke-dasharray: 2.5 3;
}
.soft,
.job,
.command,
.budget,
.ink,
.token,
.band,
.pointer {
  fill: currentColor;
}
.soft {
  opacity: 0.35;
}
.job,
.command,
.budget {
  opacity: 0.55;
}
.ink,
.token,
.pointer {
  opacity: 0.85;
}
.token,
.band,
.ghost,
.q-in,
.blob-next {
  opacity: 0;
}
.lens {
  fill: var(--tile-bg, var(--ui-bg));
  fill-opacity: 0.6;
}
.check {
  stroke-dasharray: 9;
}

.a {
  animation-duration: var(--cycle);
  animation-delay: var(--scene-delay);
  animation-iteration-count: 1;
  animation-fill-mode: both;
  animation-timing-function: var(--ease-move);
}
/* Loops run only while the scene is on screen. */
.primitive-motion:not(.is-playing) .a {
  animation-play-state: paused;
}

/* Scale and rotate around the element's own box. */
.wf-rail-1,
.wf-rail-2,
.sh-command,
.ws-file,
.blob-progress {
  transform-box: fill-box;
  transform-origin: left center;
}
.q-worker,
.sch-ring,
.mail-unread {
  transform-box: fill-box;
  transform-origin: center;
}
.sch-hand {
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
.auth-shackle {
  transform-box: fill-box;
  transform-origin: 100% 100%;
}
.br-cursor {
  transform-box: fill-box;
  transform-origin: 0 0;
}

/* Env: each value is validated in order. */
.env-check-1 { animation-name: env-check-1; }
.env-check-2 { animation-name: env-check-2; }
.env-check-3 { animation-name: env-check-3; }
.env-value-1 { animation-name: env-value-1; }
.env-value-2 { animation-name: env-value-2; }
.env-value-3 { animation-name: env-value-3; }
@keyframes env-check-1 {
  0% { opacity: 0.85; stroke-dashoffset: 0; }
  5% { opacity: 0; stroke-dashoffset: 0; }
  6%, 14% { opacity: 0.85; stroke-dashoffset: 9; }
  22%, 100% { opacity: 0.85; stroke-dashoffset: 0; }
}
@keyframes env-check-2 {
  0% { opacity: 0.85; stroke-dashoffset: 0; }
  5% { opacity: 0; stroke-dashoffset: 0; }
  6%, 26% { opacity: 0.85; stroke-dashoffset: 9; }
  34%, 100% { opacity: 0.85; stroke-dashoffset: 0; }
}
@keyframes env-check-3 {
  0% { opacity: 0.85; stroke-dashoffset: 0; }
  5% { opacity: 0; stroke-dashoffset: 0; }
  6%, 38% { opacity: 0.85; stroke-dashoffset: 9; }
  46%, 100% { opacity: 0.85; stroke-dashoffset: 0; }
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

/* Auth: a credential opens the lock, a session starts, and the lock closes again. */
.auth-token { animation-name: auth-token; }
.auth-shackle { animation-name: auth-shackle; }
.auth-session { animation-name: auth-session; }
@keyframes auth-token {
  0%, 6% { opacity: 0; transform: translateX(0); }
  10% { opacity: 0.85; transform: translateX(0); }
  24% { opacity: 0.85; transform: translateX(-14px); }
  28%, 100% { opacity: 0; transform: translateX(-16px); }
}
@keyframes auth-shackle {
  0%, 26% { transform: translateY(0) rotate(0deg); }
  36%, 62% { transform: translateY(-3px) rotate(-14deg); }
  72%, 100% { transform: translateY(0) rotate(0deg); }
}
@keyframes auth-session {
  0%, 32% { opacity: 0.35; }
  40%, 64% { opacity: 0.8; }
  76%, 100% { opacity: 0.35; }
}

/* Connections: one app calls several connected accounts, one after another. */
.conn-call-1 { animation-name: conn-call-1; }
.conn-call-2 { animation-name: conn-call-2; }
.conn-call-3 { animation-name: conn-call-3; }
.conn-service-1 { animation-name: conn-service-1; }
.conn-service-2 { animation-name: conn-service-2; }
.conn-service-3 { animation-name: conn-service-3; }
@keyframes conn-call-1 {
  0%, 4% { opacity: 0; transform: translate(0, 0); }
  7% { opacity: 0.85; transform: translate(0, 0); }
  20% { opacity: 0.85; transform: translate(21px, -7.5px); }
  23%, 100% { opacity: 0; transform: translate(23px, -8.2px); }
}
@keyframes conn-service-1 {
  0%, 19% { opacity: 0.35; }
  24%, 30% { opacity: 0.85; }
  40%, 100% { opacity: 0.35; }
}
@keyframes conn-call-3 {
  0%, 36% { opacity: 0; transform: translate(0, 0); }
  39% { opacity: 0.85; transform: translate(0, 0); }
  52% { opacity: 0.85; transform: translate(21px, 7.5px); }
  55%, 100% { opacity: 0; transform: translate(23px, 8.2px); }
}
@keyframes conn-service-3 {
  0%, 51% { opacity: 0.35; }
  56%, 62% { opacity: 0.85; }
  72%, 100% { opacity: 0.35; }
}
@keyframes conn-call-2 {
  0%, 68% { opacity: 0; transform: translateX(0); }
  71% { opacity: 0.85; transform: translateX(0); }
  84% { opacity: 0.85; transform: translateX(21px); }
  87%, 100% { opacity: 0; transform: translateX(23px); }
}
@keyframes conn-service-2 {
  0%, 83% { opacity: 0.35; }
  88%, 94% { opacity: 0.85; }
  100% { opacity: 0.35; }
}

/* Rate Limit: three calls pass the gate and spend the budget, the fourth is refused, and the budget refills. */
.rl-request { animation-name: rl-request; }
.rl-gate { animation-name: rl-gate; }
.rl-budget-1 { animation-name: rl-budget-1; }
.rl-budget-2 { animation-name: rl-budget-2; }
.rl-budget-3 { animation-name: rl-budget-3; }
@keyframes rl-request {
  0%, 4% { opacity: 0; transform: translateX(0); }
  6% { opacity: 0.85; transform: translateX(0); }
  13% { opacity: 0.85; transform: translateX(-18px); }
  15%, 18% { opacity: 0; transform: translateX(-20px); }
  18.1% { opacity: 0; transform: translateX(0); }
  20% { opacity: 0.85; transform: translateX(0); }
  27% { opacity: 0.85; transform: translateX(-18px); }
  29%, 32% { opacity: 0; transform: translateX(-20px); }
  32.1% { opacity: 0; transform: translateX(0); }
  34% { opacity: 0.85; transform: translateX(0); }
  41% { opacity: 0.85; transform: translateX(-18px); }
  43%, 46% { opacity: 0; transform: translateX(-20px); }
  46.1% { opacity: 0; transform: translateX(0); }
  48% { opacity: 0.85; transform: translateX(0); }
  55% { opacity: 0.85; transform: translateX(-17px); animation-timing-function: var(--ease-out); }
  63% { opacity: 0.5; transform: translateX(-8px); }
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

/* KV: each write pushes the entries up fast, then they settle into a slow drift. */
.kv-strip { animation-name: kv-strip; }
@keyframes kv-strip {
  0% { transform: translateY(0); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
  33.333% { transform: translateY(-8px); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
  66.667% { transform: translateY(-16px); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
  100% { transform: translateY(-24px); }
}

/* Database: a query arrives, scans to the matching row, and returns it. */
.db-token { animation-name: db-token; }
.db-band { animation-name: db-band; }
.db-match { animation-name: db-match; }
@keyframes db-token {
  0% { opacity: 0; transform: translateX(0); }
  6% { opacity: 0.85; transform: translateX(0); }
  18% { opacity: 0.85; transform: translateX(-8px); }
  22%, 100% { opacity: 0; transform: translateX(-8px); }
}
@keyframes db-band {
  0%, 18% { opacity: 0; transform: translateY(0); }
  22% { opacity: 0.1; transform: translateY(0); }
  34%, 60% { opacity: 0.1; transform: translateY(6px); }
  70%, 100% { opacity: 0; transform: translateY(6px); }
}
@keyframes db-match {
  0%, 32% { opacity: 0.35; }
  38%, 60% { opacity: 0.85; }
  72%, 100% { opacity: 0.35; }
}

/* Blob: the front upload fills, then the stack moves back and the next upload arrives. */
.blob-stack { animation-name: blob-stack; }
.blob-progress { animation-name: blob-progress; }
.blob-front { animation-name: blob-front; }
.blob-next { animation-name: blob-next; }
.blob-last { animation-name: blob-last; }
@keyframes blob-stack {
  0%, 50% { transform: translate(0, 0); }
  72%, 99.9% { transform: translate(4px, -4px); }
  100% { transform: translate(0, 0); }
}
@keyframes blob-progress {
  0%, 6% { transform: scaleX(0); }
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
.ws-token { animation-name: ws-token; }
.ws-file { animation-name: ws-file; }
@keyframes ws-token {
  0%, 6% { opacity: 0; transform: translate(0, 0); }
  10% { opacity: 0.85; transform: translate(0, 0); }
  30% { opacity: 0.85; transform: translate(0, 18px); }
  38% { opacity: 0.85; transform: translate(6px, 18px); }
  42%, 100% { opacity: 0; transform: translate(8px, 18px); }
}
@keyframes ws-file {
  0% { opacity: 0.35; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5% { opacity: 0.35; transform: scaleX(0); }
  38% { transform: scaleX(0); animation-timing-function: var(--ease-out); }
  54%, 100% { opacity: 0.35; transform: scaleX(1); }
}

/* Source: read-only content flows one way into the mounted folder. */
.src-flow { animation-name: src-flow; }
.src-flow-late { animation-delay: calc(var(--scene-delay) - var(--cycle) / 2); }
.src-mount { animation-name: src-mount; }
@keyframes src-flow {
  0% { opacity: 0; transform: translateX(0); }
  12% { opacity: 0.7; }
  74% { opacity: 0.7; transform: translateX(-13px); }
  86%, 100% { opacity: 0; transform: translateX(-15px); }
}
@keyframes src-mount {
  0%, 26%, 50%, 76%, 100% { opacity: 0.55; }
  34%, 84% { opacity: 1; }
}

/* Content: a search moves over the parsed lines and marks each match. */
.ct-lens { animation-name: ct-lens; }
.ct-line-1 { animation-name: ct-line-1; }
.ct-line-2 { animation-name: ct-line-2; }
.ct-line-3 { animation-name: ct-line-3; }
@keyframes ct-lens {
  0%, 12% { transform: translateY(0); }
  22%, 34% { transform: translateY(5px); }
  44%, 56% { transform: translateY(10px); }
  66%, 78% { transform: translateY(5px); }
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
.q-belt { animation-name: q-belt; }
.q-in { animation-name: q-in; }
.q-out { animation-name: q-out; }
.q-worker { animation-name: q-worker; }
/* The belt returns to its start on the last frame. The dots then sit where the moved dots were. */
@keyframes q-belt {
  0%, 20% { transform: translateX(0); }
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
  0%, 52% { opacity: 0.35; transform: scale(1); }
  62% { opacity: 0.85; transform: scale(1.15); }
  80% { opacity: 0.85; transform: scale(1); }
  96%, 100% { opacity: 0.35; transform: scale(1); }
}

/* Workflow: steps complete in order and the run waits at the middle step. */
.wf-step-1 { animation-name: wf-step-1; }
.wf-step-2 { animation-name: wf-step-2; }
.wf-step-3 { animation-name: wf-step-3; }
.wf-rail-1 { animation-name: wf-rail-1; }
.wf-rail-2 { animation-name: wf-rail-2; }
@keyframes wf-step-1 {
  0% { opacity: 0.85; }
  4% { opacity: 0; }
  10%, 100% { opacity: 0.85; }
}
@keyframes wf-rail-1 {
  0% { opacity: 0.85; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5% { opacity: 0.85; transform: scaleX(0); }
  10% { transform: scaleX(0); }
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
  48% { transform: scaleX(0); }
  62%, 100% { opacity: 0.85; transform: scaleX(1); }
}
@keyframes wf-step-3 {
  0% { opacity: 0.85; }
  4%, 62% { opacity: 0; }
  66%, 100% { opacity: 0.85; }
}

/* Schedule: the hand turns once, the run fires, and the next runs move closer. */
.sch-hand { animation-name: sch-hand; }
.sch-ring { animation-name: sch-ring; }
.sch-runs { animation-name: sch-runs; }
.sch-fired { animation-name: sch-fired; }
.sch-next { animation-name: sch-next; }
@keyframes sch-hand {
  0%, 4% { transform: rotate(0deg); }
  46%, 100% { transform: rotate(360deg); }
}
@keyframes sch-ring {
  0%, 46% { opacity: 0; transform: scale(1); }
  49% { opacity: 0.5; transform: scale(1); animation-timing-function: var(--ease-out); }
  68%, 100% { opacity: 0; transform: scale(1.3); }
}
@keyframes sch-runs {
  0%, 60% { transform: translateX(0); }
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
.sb-process { animation-name: sb-process; }
.sb-token { animation-name: sb-token; }
.sb-wall { animation-name: sb-wall; }
@keyframes sb-process {
  0%, 8% { opacity: 0.35; }
  14%, 60% { opacity: 0.85; }
  74%, 100% { opacity: 0.35; }
}
@keyframes sb-token {
  0%, 12% { opacity: 0; transform: translateX(0); }
  16% { opacity: 0.85; transform: translateX(0); animation-timing-function: cubic-bezier(0.5, 0, 1, 1); }
  30% { opacity: 0.85; transform: translateX(8px); animation-timing-function: var(--ease-out); }
  44% { opacity: 0.5; transform: translateX(1px); }
  50%, 100% { opacity: 0; transform: translateX(0); }
}
@keyframes sb-wall {
  0%, 28% { opacity: 0; }
  32% { opacity: 0.8; }
  56%, 100% { opacity: 0; }
}

/* Browser: the pointer moves to a control, clicks it, and returns. */
.br-cursor { animation-name: br-cursor; }
.br-button { animation-name: br-button; }
@keyframes br-cursor {
  0%, 10% { transform: translate(0, 0) scale(1); }
  32% { transform: translate(20px, 2px) scale(1); }
  35% { transform: translate(20px, 2px) scale(0.85); }
  39%, 60% { transform: translate(20px, 2px) scale(1); }
  86%, 100% { transform: translate(0, 0) scale(1); }
}
@keyframes br-button {
  0%, 34% { opacity: 0.35; }
  39%, 58% { opacity: 0.8; }
  70%, 100% { opacity: 0.35; }
}

/* Shell: the command is typed, then its output appears. */
.sh-command { animation-name: sh-command; }
.sh-cursor { animation-name: sh-cursor; }
.sh-output-1 { animation-name: sh-output-1; }
.sh-output-2 { animation-name: sh-output-2; }
@keyframes sh-command {
  0% { opacity: 0.55; transform: scaleX(1); }
  4% { opacity: 0; transform: scaleX(1); }
  5%, 8% { opacity: 0.55; transform: scaleX(0); animation-timing-function: steps(6, end); }
  36%, 100% { opacity: 0.55; transform: scaleX(1); }
}
@keyframes sh-cursor {
  0% { opacity: 0.85; transform: translateX(0); }
  4% { opacity: 0; transform: translateX(0); }
  5%, 8% { opacity: 0.85; transform: translateX(-21px); animation-timing-function: steps(6, end); }
  36%, 100% { opacity: 0.85; transform: translateX(0); }
}
@keyframes sh-output-1 {
  0% { opacity: 0.35; transform: translateY(0); }
  4%, 40% { opacity: 0; transform: translateY(2px); animation-timing-function: var(--ease-out); }
  48%, 100% { opacity: 0.35; transform: translateY(0); }
}
@keyframes sh-output-2 {
  0% { opacity: 0.35; transform: translateY(0); }
  4%, 46% { opacity: 0; transform: translateY(2px); animation-timing-function: var(--ease-out); }
  54%, 100% { opacity: 0.35; transform: translateY(0); }
}

/* Email: a message leaves the envelope and lands in the inbox as unread. */
.mail-token { animation-name: mail-token; }
.mail-unread { animation-name: mail-unread; }
@keyframes mail-token {
  0%, 6% { opacity: 0; transform: translateX(0); }
  12% { opacity: 0.85; transform: translateX(0); }
  38% { opacity: 0.85; transform: translateX(14px); }
  42%, 100% { opacity: 0; transform: translateX(16px); }
}
@keyframes mail-unread {
  0%, 40% { opacity: 0; transform: scale(0.6); }
  46% { opacity: 0.85; transform: scale(1); animation-timing-function: var(--ease-out); }
  80% { opacity: 0.85; transform: scale(1); }
  92%, 100% { opacity: 0; transform: scale(1); }
}

/* Realtime: two collaborators move between lines of the same document. */
.rt-caret-a { animation-name: rt-caret-a; }
.rt-caret-b { animation-name: rt-caret-b; }
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

@media (prefers-reduced-motion: reduce) {
  .a {
    animation: none;
  }
}
</style>
