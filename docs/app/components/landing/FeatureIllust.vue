<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { useMediaQuery } from "@vueuse/core";

const props = defineProps<{ name: string }>();
const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

// blob: polaroid card swipe
const blobTick = ref(0);
let blobTimer: ReturnType<typeof setTimeout> | undefined;
const blobRatios = [[20, 28], [28, 20], [24, 24]] as const;
const blobStateMap = new Map<number, { angle: number; ratio: number; variant: number }>();
function blobState(id: number) {
  if (!blobStateMap.has(id)) blobStateMap.set(id, { angle: -12 + Math.random() * 24, ratio: Math.floor(Math.random() * 3), variant: Math.floor(Math.random() * 5) });
  return blobStateMap.get(id)!;
}
const blobCards = computed(() => Array.from({ length: 3 }, (_, i) => {
  const id = blobTick.value - i;
  const s = blobState(id);
  const r = blobRatios[s.ratio]!;
  return { id, angle: s.angle, w: r[0], h: r[1], x: (48 - r[0]) / 2, y: (48 - r[1]) / 2, variant: s.variant };
}));
function blobNext() {
  blobTick.value++;
  blobTimer = setTimeout(blobNext, 2200 + Math.random() * 1000);
}

// shell: command output stream
const sbTick = ref(0);
let sbTimer: ReturnType<typeof setInterval> | undefined;
const sbLines = computed(() => Array.from({ length: 4 }, (_, i) => ({ id: sbTick.value - i })));

onMounted(() => {
  if (prefersReducedMotion.value) return;
  if (props.name === "blob") blobTimer = setTimeout(blobNext, 2200);
  if (props.name === "shell") sbTimer = setInterval(() => sbTick.value++, 1800);
});
onUnmounted(() => {
  if (blobTimer) clearTimeout(blobTimer);
  if (sbTimer) clearInterval(sbTimer);
});
</script>

<template>
  <!-- kv: key maps to a value, write pulse travels across -->
  <svg v-if="name === 'kv'" viewBox="0 0 48 48" class="size-full">
    <circle cx="12" cy="24" r="5" fill="none" stroke="currentColor" stroke-width="2" opacity=".5" />
    <line x1="16" y1="24" x2="21" y2="24" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5" />
    <rect x="28" y="18" width="14" height="12" rx="2" fill="currentColor" class="fi-kv-val" />
    <circle cx="22" cy="24" r="2" fill="currentColor" class="fi-kv-dot" />
  </svg>

  <!-- database: query highlight sweeping table rows -->
  <svg v-else-if="name === 'database'" viewBox="0 0 48 48" class="size-full overflow-hidden">
    <rect x="8" y="8" width="32" height="32" rx="3" fill="none" stroke="currentColor" stroke-width="1.25" opacity=".25" />
    <line x1="8" y1="16" x2="40" y2="16" stroke="currentColor" stroke-width="1" opacity=".2" />
    <rect x="9" y="19" width="30" height="4.5" rx="1" fill="currentColor" opacity=".18" class="fi-db-scan" />
    <rect v-for="i in 4" :key="i" x="11" :y="20 + (i - 1) * 5" width="26" height="2.6" rx="1" fill="currentColor" :opacity="0.35 - (i - 1) * 0.05" />
  </svg>

  <!-- queue: balls crawling along a track -->
  <svg v-else-if="name === 'queue'" viewBox="0 0 600 40" class="size-full">
    <line x1="5" y1="20" x2="595" y2="20" stroke="currentColor" stroke-width="1" opacity=".15" stroke-dasharray="4 3" />
    <template v-if="prefersReducedMotion">
      <circle cx="400" cy="20" r="14" fill="currentColor" opacity=".4" />
      <circle cx="470" cy="20" r="14" fill="currentColor" opacity=".5" />
      <circle cx="540" cy="20" r="14" fill="currentColor" opacity=".6" />
    </template>
    <template v-else>
      <motion.circle
        v-for="i in 5" :key="i"
        cx="0" cy="20" r="14" fill="currentColor"
        :animate="{ x: [-20, 380, 500, 620], opacity: [0, 0.55, 0.55, 0.55] }"
        :transition="{ duration: 8, repeat: Infinity, times: [0, 0.15, 0.98, 1], ease: ['easeInOut', 'linear', 'easeIn'], delay: (i - 1) * -2 }"
      />
    </template>
  </svg>

  <!-- schedule: clock with rotating hand + radar pulse -->
  <svg v-else-if="name === 'schedule'" viewBox="0 0 48 48" class="size-full overflow-visible">
    <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".2" />
    <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="1.5" class="fi-radar" />
    <circle cx="24" cy="24" r="2.5" fill="currentColor" opacity=".6" />
    <line x1="24" y1="24" x2="24" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5" class="fi-hand" />
    <circle v-for="h in 12" :key="h" :cx="24 + 17 * Math.cos((h * 30 - 90) * Math.PI / 180)" :cy="24 + 17 * Math.sin((h * 30 - 90) * Math.PI / 180)" r="1" fill="currentColor" opacity=".15" />
  </svg>

  <!-- workflow: token advancing step to step, with a retry loop -->
  <svg v-else-if="name === 'workflow'" viewBox="0 0 48 48" class="size-full overflow-visible">
    <line x1="10" y1="22" x2="38" y2="22" stroke="currentColor" stroke-width="1.25" opacity=".25" stroke-dasharray="2 2" />
    <path d="M38 26 Q24 40 10 26" fill="none" stroke="currentColor" stroke-width="1.25" opacity=".2" stroke-dasharray="2 2" />
    <circle v-for="n in 3" :key="n" :cx="10 + (n - 1) * 14" cy="22" r="4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5" />
    <circle cx="10" cy="22" r="2.5" fill="currentColor" class="fi-wf-token" />
  </svg>

  <!-- sandbox: isolated artifact, beams rejected at the boundary -->
  <svg v-else-if="name === 'sandbox'" viewBox="0 0 48 48" class="size-full overflow-visible">
    <rect x="6" y="6" width="36" height="36" rx="5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3" />
    <g class="fi-beams">
      <line x1="24" y1="24" x2="24" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <line x1="24" y1="24" x2="39" y2="24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <line x1="24" y1="24" x2="24" y2="39" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <line x1="24" y1="24" x2="9" y2="24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </g>
    <rect x="6" y="6" width="36" height="36" rx="5" fill="none" stroke="currentColor" stroke-width="2" class="fi-reject" />
    <rect x="19.5" y="19.5" width="9" height="9" rx="2" fill="currentColor" opacity=".6" class="fi-artifact" />
  </svg>

  <!-- shell: command prompt with streaming output -->
  <svg v-else-if="name === 'shell'" viewBox="0 0 48 48" class="size-full overflow-hidden">
    <rect x="7" y="9" width="34" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1.25" opacity=".3" />
    <line x1="7" y1="16" x2="41" y2="16" stroke="currentColor" stroke-width="1" opacity=".15" />
    <path d="M11 11 l2.6 1.6 l-2.6 1.6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" opacity=".6" />
    <rect x="16.5" y="11.4" width="9" height="2.2" rx="1" fill="currentColor" opacity=".5" />
    <rect x="27" y="10.8" width="2" height="3.4" fill="currentColor" opacity=".75" class="fi-blink" />
    <template v-if="prefersReducedMotion">
      <rect x="11" y="21" width="18" height="2.2" rx="1" fill="currentColor" opacity=".4" />
      <rect x="11" y="26" width="13" height="2.2" rx="1" fill="currentColor" opacity=".3" />
      <rect x="11" y="31" width="21" height="2.2" rx="1" fill="currentColor" opacity=".2" />
    </template>
    <template v-else>
      <defs><clipPath id="sh-clip"><rect x="7" y="17" width="34" height="22" rx="3" /></clipPath></defs>
      <g clip-path="url(#sh-clip)">
        <AnimatePresence>
          <motion.rect
            v-for="(line, idx) in sbLines" :key="line.id"
            x="11" :width="14 + (line.id % 3) * 5" height="2.2" rx="1" fill="currentColor"
            :initial="{ y: 41, opacity: 0 }"
            :animate="{ y: 33 - idx * 5, opacity: 0.5 - idx * 0.1 }"
            :exit="{ y: 18, opacity: 0 }"
            :transition="{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }"
          />
        </AnimatePresence>
      </g>
    </template>
  </svg>

  <!-- blob: polaroid card swipe -->
  <svg v-else-if="name === 'blob'" viewBox="0 0 48 48" class="size-full overflow-visible">
    <template v-if="prefersReducedMotion">
      <rect x="12" y="8" width="24" height="32" rx="2.5" fill="none" stroke="currentColor" stroke-width=".75" opacity=".25" />
      <rect x="12" y="8" width="24" height="32" rx="2.5" fill="currentColor" opacity=".2" />
    </template>
    <AnimatePresence v-else>
      <motion.g
        v-for="(card, idx) in blobCards" :key="card.id"
        :initial="{ x: card.id % 2 === 0 ? 40 : -40, rotate: card.angle * 2, opacity: 0 }"
        :animate="{ x: 0, y: 0, rotate: card.angle, opacity: 1 }"
        :exit="{ opacity: 0 }"
        :transition="{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }"
        style="transform-origin: 24px 24px"
      >
        <rect v-if="idx === 0" :x="card.x" :y="card.y" :width="card.w" :height="card.h" rx="2.5" fill="white" />
        <rect v-if="idx === 0" :x="card.x" :y="card.y" :width="card.w" :height="card.h" rx="2.5" fill="currentColor" opacity=".1" />
        <rect :x="card.x" :y="card.y" :width="card.w" :height="card.h" rx="2.5" fill="none" stroke="currentColor" stroke-width="1" :opacity="idx === 0 ? 0.4 : 0.15" />
        <template v-if="idx === 0">
          <template v-if="card.variant === 0">
            <path :d="`M${card.x + 3},${card.y + card.h - 4} L${card.x + card.w / 2},${card.y + card.h * 0.3} L${card.x + card.w - 3},${card.y + card.h - 4}`" stroke="currentColor" stroke-width="2" fill="none" opacity=".7" stroke-linejoin="round" />
            <circle :cx="card.x + card.w - 5" :cy="card.y + 5" r="3" fill="currentColor" opacity=".65" />
          </template>
          <template v-else-if="card.variant === 1">
            <rect :x="card.x + 4" :y="card.y + card.h * 0.55" :width="5" :height="card.h * 0.3" rx="1" fill="currentColor" opacity=".55" />
            <rect :x="card.x + 11" :y="card.y + card.h * 0.3" :width="5" :height="card.h * 0.55" rx="1" fill="currentColor" opacity=".7" />
            <rect :x="card.x + 18" :y="card.y + card.h * 0.15" :width="5" :height="card.h * 0.7" rx="1" fill="currentColor" opacity=".55" />
          </template>
          <template v-else-if="card.variant === 2">
            <rect :x="card.x + 3" :y="card.y + 3" :width="card.w * 0.4" :height="card.h * 0.35" rx="1.5" fill="currentColor" opacity=".5" />
            <rect :x="card.x + card.w * 0.5" :y="card.y + 3" :width="card.w * 0.4" :height="card.h * 0.35" rx="1.5" fill="currentColor" opacity=".65" />
            <rect :x="card.x + 3" :y="card.y + card.h * 0.45" :width="card.w * 0.4" :height="card.h * 0.35" rx="1.5" fill="currentColor" opacity=".65" />
            <rect :x="card.x + card.w * 0.5" :y="card.y + card.h * 0.45" :width="card.w * 0.4" :height="card.h * 0.35" rx="1.5" fill="currentColor" opacity=".5" />
          </template>
          <template v-else-if="card.variant === 3">
            <circle :cx="card.x + card.w / 2" :cy="card.y + card.h / 2" :r="Math.min(card.w, card.h) * 0.3" fill="currentColor" opacity=".5" />
            <circle :cx="card.x + card.w / 2" :cy="card.y + card.h / 2" :r="Math.min(card.w, card.h) * 0.12" fill="currentColor" opacity=".35" />
          </template>
          <template v-else>
            <line :x1="card.x + 3" :y1="card.y + card.h - 3" :x2="card.x + card.w * 0.4" :y2="card.y + 4" stroke="currentColor" stroke-width="2" opacity=".55" stroke-linecap="round" />
            <line :x1="card.x + card.w * 0.3" :y1="card.y + card.h - 3" :x2="card.x + card.w * 0.7" :y2="card.y + 4" stroke="currentColor" stroke-width="2" opacity=".7" stroke-linecap="round" />
            <line :x1="card.x + card.w * 0.6" :y1="card.y + card.h - 3" :x2="card.x + card.w - 3" :y2="card.y + card.h * 0.3" stroke="currentColor" stroke-width="2" opacity=".55" stroke-linecap="round" />
          </template>
        </template>
      </motion.g>
    </AnimatePresence>
  </svg>

  <!-- auth: padlock shackle lifting open -->
  <svg v-else-if="name === 'auth'" viewBox="0 0 48 48" class="size-full overflow-visible">
    <rect x="13" y="22" width="22" height="17" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45" />
    <circle cx="24" cy="29" r="2.2" fill="currentColor" opacity=".6" />
    <line x1="24" y1="29" x2="24" y2="34" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".6" />
    <path d="M18 22 v-3 a6 6 0 0 1 12 0 v3" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45" class="fi-shackle" />
  </svg>

  <!-- env: values cleared through a validation gate -->
  <svg v-else-if="name === 'env'" viewBox="0 0 48 48" class="size-full overflow-hidden">
    <line x1="31" y1="9" x2="31" y2="39" stroke="currentColor" stroke-width="1.25" opacity=".3" stroke-dasharray="2 2" />
    <path d="M34 12 l2 2 l4 -5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".6" class="fi-pulse" />
    <rect
      v-for="i in 3" :key="i"
      x="6" :y="17 + (i - 1) * 8" width="14" height="3" rx="1.5" fill="currentColor"
      :opacity="0.5 - (i - 1) * 0.1"
      class="fi-env-flow"
      :class="`[animation-delay:${(i - 1) * 500}ms]`"
    />
  </svg>

  <!-- workspace: file tree over a bash prompt -->
  <svg v-else-if="name === 'workspace'" viewBox="0 0 48 48" class="size-full overflow-hidden">
    <path d="M8 11 h6 l2 2 h6" fill="none" stroke="currentColor" stroke-width="1.25" opacity=".3" />
    <rect v-for="i in 2" :key="i" x="15" :y="17 + (i - 1) * 5" :width="16 - (i - 1) * 5" height="2.6" rx="1" fill="currentColor" :opacity="0.4 - (i - 1) * 0.12" />
    <line x1="8" y1="30" x2="40" y2="30" stroke="currentColor" stroke-width="1" opacity=".15" />
    <path d="M9 33 l3 2 l-3 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".6" />
    <rect x="15" y="33.5" width="12" height="2.6" rx="1" fill="currentColor" opacity=".4" />
    <rect x="28.5" y="32.8" width="2" height="4" fill="currentColor" opacity=".7" class="fi-blink" />
  </svg>

  <!-- source: document with a retrieval scan -->
  <svg v-else-if="name === 'source'" viewBox="0 0 48 48" class="size-full">
    <path d="M13 5 h15 l8 8 v30 h-23 z" fill="none" stroke="currentColor" stroke-width="1.25" opacity=".25" />
    <path d="M28 5 v8 h8" fill="none" stroke="currentColor" stroke-width="1.25" opacity=".25" />
    <rect x="15" y="17" width="20" height="5" rx="1" fill="currentColor" opacity=".15" class="fi-scan" />
    <rect v-for="i in 4" :key="i" x="18" :y="18 + (i - 1) * 5" :width="14 - (i % 2) * 4" height="2.5" rx="1" fill="currentColor" :opacity="0.45 - (i - 1) * 0.08" />
  </svg>
</template>

<style>
.fi-hand { animation: fi-rotate 3s linear infinite; transform-origin: 50% 50%; transform-box: view-box; }
.fi-radar { animation: fi-radar 3s ease-out infinite; transform-origin: center; transform-box: fill-box; opacity: 0; }
.fi-pulse { animation: fi-pulse 2.4s ease-in-out infinite; }
.fi-scan { animation: fi-scan 3s ease-in-out infinite; }
.fi-blink { animation: fi-blink 1.1s step-end infinite; }
.fi-beams { animation: fi-beam 2.6s ease-out infinite; transform-origin: 24px 24px; transform-box: view-box; opacity: 0; }
.fi-reject { animation: fi-reject 2.6s ease-out infinite; transform-origin: center; transform-box: fill-box; opacity: 0; }
.fi-artifact { animation: fi-artifact 2.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
.fi-kv-dot { animation: fi-kv-dot 2.4s ease-in-out infinite; transform-box: view-box; }
.fi-kv-val { animation: fi-kv-val 2.4s ease-in-out infinite; }
.fi-db-scan { animation: fi-db-scan 2.6s steps(4, jump-none) infinite; transform-box: view-box; }
.fi-wf-token { animation: fi-wf-token 2.8s steps(2, jump-none) infinite; transform-box: view-box; }
.fi-shackle { animation: fi-shackle 3s ease-in-out infinite; transform-origin: 30px 22px; transform-box: view-box; }
.fi-env-flow { animation: fi-env-flow 2.4s ease-in infinite; transform-box: view-box; }

@keyframes fi-rotate { to { transform: rotate(360deg); } }
@keyframes fi-radar { 0% { transform: scale(1); opacity: 0.35; } 40% { transform: scale(1.4); opacity: 0; } 100% { opacity: 0; } }
@keyframes fi-pulse { 0%, 100% { opacity: 0.8; } 50% { opacity: 0.3; } }
@keyframes fi-scan { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(11px); } }
@keyframes fi-blink { 0%, 49% { opacity: 0.75; } 50%, 100% { opacity: 0; } }
@keyframes fi-beam { 0% { transform: scale(0.15); opacity: 0; } 35% { opacity: 0.5; } 62%, 100% { transform: scale(1); opacity: 0; } }
@keyframes fi-reject { 0%, 55% { opacity: 0; } 64% { opacity: 0.5; } 100% { opacity: 0; } }
@keyframes fi-artifact { 0%, 100% { opacity: 0.4; } 30% { opacity: 0.7; } }
@keyframes fi-kv-dot { 0% { transform: translateX(0); opacity: 0; } 20% { opacity: 0.7; } 80% { transform: translateX(11px); opacity: 0; } 100% { opacity: 0; } }
@keyframes fi-kv-val { 0%, 55% { opacity: 0.15; } 80% { opacity: 0.55; } 100% { opacity: 0.15; } }
@keyframes fi-db-scan { 0% { transform: translateY(0); } 100% { transform: translateY(15px); } }
@keyframes fi-wf-token { 0% { transform: translateX(0); } 100% { transform: translateX(28px); } }
@keyframes fi-shackle { 0%, 55% { transform: rotate(0deg); } 72% { transform: rotate(-26deg); } 100% { transform: rotate(0deg); } }
@keyframes fi-env-flow { 0% { transform: translateX(0); opacity: 0.5; } 70% { transform: translateX(16px); opacity: 0.5; } 100% { transform: translateX(22px); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .fi-hand, .fi-radar, .fi-pulse, .fi-scan, .fi-blink, .fi-beams, .fi-reject, .fi-artifact,
  .fi-kv-dot, .fi-kv-val, .fi-db-scan, .fi-wf-token, .fi-shackle, .fi-env-flow { animation: none !important; }
  .fi-artifact { opacity: 0.6 !important; }
  .fi-kv-val { opacity: 0.4 !important; }
  .fi-env-flow { opacity: 0.4 !important; transform: none !important; }
}
</style>
