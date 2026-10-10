<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { motion, MotionConfig } from "motion-v";
import { landingPrimitives } from "./content";

type PrimitiveId = (typeof landingPrimitives)[number]["id"];

const grid = useTemplateRef<HTMLElement>("grid");
const visible = ref(false);
const activeId = ref<PrimitiveId | null>(null);
const focusedId = ref<PrimitiveId | null>(null);
const indicatorId = `primitive-focus-${useId()}`;

useIntersectionObserver(grid, ([entry]) => {
  visible.value = entry?.isIntersecting ?? false;
});

function focus(id: PrimitiveId) {
  focusedId.value = id;
  activeId.value = id;
}

function blur() {
  focusedId.value = null;
  activeId.value = null;
}
</script>

<template>
  <div id="primitives">
    <MotionConfig reduced-motion="user">
      <ul
        ref="grid"
        class="primitive-grid grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-7"
        aria-label="ViteHub APIs"
        @pointerleave="activeId = focusedId"
      >
        <li v-for="(primitive, index) in landingPrimitives" :key="primitive.id" class="min-w-0 last:col-span-2 sm:last:col-span-1">
          <NuxtLink
            :to="primitive.to"
            class="primitive-tile group"
            @focus="focus(primitive.id)"
            @blur="blur"
            @pointerenter="activeId = primitive.id"
          >
            <motion.div
              v-if="activeId === primitive.id"
              :layout-id="indicatorId"
              :initial="false"
              :transition="{ type: 'spring', stiffness: 450, damping: 36 }"
              class="primitive-focus"
              aria-hidden="true"
            />
            <div class="primitive-illustration h-10 w-16 text-muted">
              <LandingPrimitiveMotion :name="primitive.id" :play="visible" :offset="(index * 0.37) % 1" />
            </div>
            <div>
              <h2 class="text-sm font-medium text-highlighted">{{ primitive.name }}</h2>
              <p class="mt-0.5 text-xs/5 text-muted">{{ primitive.description }}</p>
            </div>
            <UIcon name="i-lucide-arrow-up-right" class="primitive-arrow size-3.5" aria-hidden="true" />
          </NuxtLink>
        </li>
      </ul>
    </MotionConfig>
  </div>
</template>

<style scoped>
.primitive-grid {
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}

.primitive-tile {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 9rem;
  flex-direction: column;
  justify-content: space-between;
  gap: 0.75rem;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 1rem 1.25rem;
  background: var(--ui-bg);
}

.primitive-tile:focus-visible {
  z-index: 1;
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

.primitive-focus {
  position: absolute;
  z-index: 1;
  inset: -1px;
  border: 1px solid var(--ui-text-highlighted);
  pointer-events: none;
}

.primitive-illustration {
  opacity: 0.72;
  transition: opacity 200ms ease, transform 200ms ease, color 200ms ease;
}

.primitive-arrow {
  position: absolute;
  top: 1.25rem;
  right: 1.25rem;
  color: var(--ui-text-muted);
  opacity: 0;
  transform: translate(-2px, 2px);
  transition: opacity 180ms ease, transform 180ms ease;
}

.primitive-tile:focus-visible .primitive-illustration {
  color: var(--ui-text-highlighted);
  opacity: 1;
}

.primitive-tile:focus-visible .primitive-arrow {
  opacity: 1;
  transform: translate(0, 0);
}

@media (hover: hover) and (pointer: fine) {
  .primitive-tile:hover .primitive-illustration {
    color: var(--ui-text-highlighted);
    opacity: 1;
    transform: translateY(-2px);
  }

  .primitive-tile:hover .primitive-arrow {
    opacity: 1;
    transform: translate(0, 0);
  }
}

@media (min-width: 640px) {
  .primitive-tile {
    padding: 1.25rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .primitive-illustration,
  .primitive-arrow {
    transition: none;
    transform: none;
  }
}
</style>
