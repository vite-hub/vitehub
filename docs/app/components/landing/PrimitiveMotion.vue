<script setup lang="ts">
const props = defineProps<{ name: string }>();

const primitives = [
  "workspace",
  "kv",
  "queue",
  "workflow",
  "schedule",
  "sandbox",
  "database",
  "blob",
  "auth",
  "env",
  "source",
  "shell",
];
const delay = `${Math.max(0, primitives.indexOf(props.name)) * 60}ms`;
</script>

<template>
  <svg
    viewBox="0 0 96 56"
    class="primitive-motion size-full"
    :style="{ '--scene-delay': delay }"
    aria-hidden="true"
  >
    <template v-if="name === 'kv'">
      <circle cx="19" cy="28" r="7" class="outline" />
      <path d="M26 28h38" class="line" />
      <rect x="66" y="20" width="18" height="16" rx="2" class="fill target" />
      <circle cx="31" cy="28" r="2.5" class="accent write" />
    </template>
    <template v-else-if="name === 'database'">
      <rect x="20" y="8" width="56" height="40" rx="3" class="outline" />
      <path d="M20 17h56" class="line" />
      <rect x="24" y="21" width="48" height="5" rx="1" class="fill db-scan" />
      <path d="M25 23h33M25 31h43M25 39h37" class="line" />
    </template>
    <template v-else-if="name === 'queue'">
      <path d="M10 28h76" class="line dashed" />
      <circle cx="24" cy="28" r="5" class="fill" />
      <circle cx="42" cy="28" r="5" class="fill" />
      <circle cx="60" cy="28" r="5" class="accent queue-item" />
      <path d="m78 24 5 4-5 4" class="outline" />
    </template>
    <template v-else-if="name === 'schedule'">
      <circle cx="48" cy="28" r="20" class="outline" />
      <path d="M48 28V14M48 28l9 6" class="accent clock-hand" />
      <circle cx="48" cy="28" r="2.5" class="fill" />
      <circle cx="48" cy="28" r="20" class="accent trigger" />
    </template>
    <template v-else-if="name === 'workflow'">
      <path d="M20 23h56M76 30Q48 49 20 30" class="line dashed" />
      <circle v-for="x in [20, 48, 76]" :key="x" :cx="x" cy="23" r="6" class="outline" />
      <circle cx="20" cy="23" r="3" class="accent workflow-token" />
    </template>
    <template v-else-if="name === 'sandbox'">
      <rect x="26" y="8" width="44" height="40" rx="5" class="outline boundary" />
      <rect x="43" y="23" width="10" height="10" rx="2" class="fill" />
      <path d="M48 23V13M53 28h11M48 33v10M43 28H32" class="accent rejected" />
    </template>
    <template v-else-if="name === 'shell'">
      <rect x="18" y="8" width="60" height="40" rx="4" class="outline" />
      <path d="M18 17h60M25 23l5 4-5 4M34 31h16" class="line" />
      <g class="shell-output"><path d="M25 37h38M25 42h27" class="accent" /></g>
    </template>
    <template v-else-if="name === 'blob'">
      <g class="stored-card back">
        <rect x="31" y="13" width="30" height="32" rx="2" class="outline" />
      </g>
      <g class="stored-card front">
        <rect x="35" y="10" width="30" height="32" rx="2" class="fill" />
        <path d="m39 35 7-8 6 5 7-10" class="accent" />
        <circle cx="57" cy="17" r="3" class="accent" />
      </g>
    </template>
    <template v-else-if="name === 'auth'">
      <rect x="32" y="26" width="32" height="23" rx="3" class="outline" />
      <path d="M39 26v-6a9 9 0 0 1 18 0v6" class="accent shackle" />
      <path d="M48 34v7" class="line" />
      <circle cx="48" cy="34" r="2.5" class="fill" />
    </template>
    <template v-else-if="name === 'env'">
      <path d="M56 10v36" class="line dashed" />
      <path d="m64 18 4 4 8-9" class="accent env-check" />
      <path d="M19 19h22M19 28h18M19 37h25" class="accent env-values" />
    </template>
    <template v-else-if="name === 'workspace'">
      <path d="M17 10h19l5 5h16v16H17zM24 20h24M24 26h17" class="outline" />
      <path d="M17 35h62v15H17zM24 40l5 3-5 3M34 46h17" class="line" />
      <rect x="54" y="42" width="3" height="5" class="fill workspace-cursor" />
    </template>
    <template v-else-if="name === 'source'">
      <path d="M32 5h24l9 9v37H32zM56 5v9h9" class="outline" />
      <path d="M39 21h19M39 29h15M39 37h19" class="line" />
      <rect x="36" y="18" width="25" height="7" rx="1" class="fill source-scan" />
    </template>
  </svg>
</template>

<style scoped>
.primitive-motion {
  --cycle: 4.8s;
  --motion-out: cubic-bezier(0.23, 1, 0.32, 1);
  --motion-move: cubic-bezier(0.77, 0, 0.175, 1);
  overflow: visible;
}
.outline,
.line,
.accent {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.outline {
  stroke-width: 1.5;
  opacity: 0.34;
}
.line {
  stroke-width: 1.5;
  opacity: 0.22;
}
.accent {
  stroke-width: 1.8;
  opacity: 0.72;
}
.fill {
  fill: currentColor;
  opacity: 0.22;
}
.dashed {
  stroke-dasharray: 3 4;
}
.write,
.queue-item,
.workflow-token,
.db-scan,
.clock-hand,
.trigger,
.rejected,
.boundary,
.shell-output,
.stored-card,
.shackle,
.env-values,
.env-check,
.workspace-cursor,
.source-scan,
.target {
  animation-duration: var(--cycle);
  animation-delay: var(--scene-delay);
  animation-iteration-count: infinite;
  animation-fill-mode: both;
}
.write {
  animation-name: arrive-right;
  animation-timing-function: var(--motion-out);
}
.target {
  animation-name: confirm;
  animation-timing-function: var(--motion-out);
}
.db-scan,
.source-scan {
  animation-name: scan-down;
  animation-timing-function: var(--motion-move);
}
.queue-item {
  animation-name: queue-forward;
  animation-timing-function: var(--motion-move);
}
.workflow-token {
  animation-name: workflow-handoff;
  animation-timing-function: var(--motion-move);
}
.clock-hand {
  transform-origin: 48px 28px;
  transform-box: view-box;
  animation-name: clock-trigger;
  animation-timing-function: var(--motion-move);
}
.trigger {
  transform-origin: center;
  transform-box: fill-box;
  animation-name: confirm-ring;
  animation-timing-function: var(--motion-out);
}
.rejected {
  transform-origin: center;
  transform-box: fill-box;
  animation-name: reject;
  animation-timing-function: var(--motion-out);
}
.boundary,
.env-check {
  animation-name: confirm;
  animation-timing-function: var(--motion-out);
}
.shell-output {
  animation-name: output-arrive;
  animation-timing-function: var(--motion-out);
}
.stored-card {
  transform-origin: center;
  transform-box: fill-box;
  animation-name: store-card;
  animation-timing-function: var(--motion-out);
}
.stored-card.back {
  animation-delay: calc(var(--scene-delay) - 80ms);
}
.shackle {
  transform-origin: 57px 26px;
  transform-box: view-box;
  animation-name: unlock;
  animation-timing-function: var(--motion-move);
}
.env-values {
  animation-name: validate;
  animation-timing-function: var(--motion-move);
}
.workspace-cursor {
  animation-name: cursor-result;
  animation-timing-function: var(--motion-out);
}

@keyframes arrive-right {
  0%,
  3% {
    opacity: 0;
    transform: translateX(-12px);
  }
  15%,
  100% {
    opacity: 0.75;
    transform: translateX(32px);
  }
}
@keyframes confirm {
  0%,
  12% {
    opacity: 0.15;
  }
  18%,
  100% {
    opacity: 0.55;
  }
}
@keyframes scan-down {
  0%,
  3% {
    opacity: 0;
    transform: translateY(-5px);
  }
  17%,
  100% {
    opacity: 0.5;
    transform: translateY(17px);
  }
}
@keyframes queue-forward {
  0%,
  3% {
    transform: translateX(0);
    opacity: 0.72;
  }
  17%,
  100% {
    transform: translateX(18px);
    opacity: 0.72;
  }
}
@keyframes workflow-handoff {
  0%,
  3% {
    transform: translateX(0);
  }
  10% {
    transform: translateX(28px);
  }
  17%,
  100% {
    transform: translateX(56px);
  }
}
@keyframes clock-trigger {
  0%,
  3% {
    transform: rotate(0);
  }
  17%,
  100% {
    transform: rotate(90deg);
  }
}
@keyframes confirm-ring {
  0%,
  12% {
    opacity: 0;
    transform: scale(0.85);
  }
  18% {
    opacity: 0.55;
  }
  24%,
  100% {
    opacity: 0;
    transform: scale(1.18);
  }
}
@keyframes reject {
  0%,
  3% {
    opacity: 0;
    transform: scale(0.3);
  }
  13% {
    opacity: 0.75;
    transform: scale(1);
  }
  20%,
  100% {
    opacity: 0;
    transform: scale(1);
  }
}
@keyframes output-arrive {
  0%,
  3% {
    opacity: 0;
    transform: translateY(8px);
  }
  17%,
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes store-card {
  0%,
  3% {
    opacity: 0;
    transform: translateX(18px) rotate(8deg);
  }
  17%,
  100% {
    opacity: 1;
    transform: translateX(0) rotate(0);
  }
}
@keyframes unlock {
  0%,
  3% {
    transform: rotate(0);
  }
  17%,
  100% {
    transform: rotate(-28deg);
  }
}
@keyframes validate {
  0%,
  3% {
    opacity: 0.35;
    transform: translateX(0);
  }
  17%,
  100% {
    opacity: 0.72;
    transform: translateX(18px);
  }
}
@keyframes cursor-result {
  0%,
  9% {
    opacity: 0;
  }
  14%,
  100% {
    opacity: 0.7;
  }
}

@media (prefers-reduced-motion: reduce) {
  .write,
  .queue-item,
  .workflow-token,
  .db-scan,
  .clock-hand,
  .trigger,
  .rejected,
  .boundary,
  .shell-output,
  .stored-card,
  .shackle,
  .env-values,
  .env-check,
  .workspace-cursor,
  .source-scan,
  .target {
    animation: reduced-confirm 4.8s linear var(--scene-delay) infinite both;
    transform: none;
  }
  .write {
    transform: translateX(32px);
  }
  .queue-item {
    transform: translateX(18px);
  }
  .workflow-token {
    transform: translateX(56px);
  }
  .db-scan,
  .source-scan {
    transform: translateY(17px);
  }
  @keyframes reduced-confirm {
    0%,
    4% {
      opacity: 0.45;
    }
    8%,
    100% {
      opacity: 0.7;
    }
  }
}
</style>
