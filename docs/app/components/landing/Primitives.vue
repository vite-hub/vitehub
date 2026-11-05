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

// The last tile spans the columns that are left in its row, so the grid never ends with a hole.
// Keep these counts in sync with the grid-cols classes below.
const lastTileSpans = Object.fromEntries(
  Object.entries({ base: 2, sm: 3, xl: 7 }).map(([breakpoint, columns]) => [
    `--last-span-${breakpoint}`,
    String(columns - ((landingPrimitives.length - 1) % columns)),
  ]),
);

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
        <li
          v-for="(primitive, index) in landingPrimitives"
          :key="primitive.id"
          class="primitive-cell min-w-0"
          :style="index === landingPrimitives.length - 1 ? lastTileSpans : undefined"
        >
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
            <LandingPrimitiveLines
              :icon="primitive.icon"
              :active="activeId === primitive.id"
              :play="visible"
              :delay="240 + index * 35"
              class="primitive-lines"
            />
            <div class="relative">
              <h2 class="text-sm font-medium text-highlighted">{{ primitive.name }}</h2>
              <p class="primitive-description mt-0.5 text-xs/5 text-muted">{{ primitive.description }}</p>
            </div>
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

.primitive-cell:last-child {
  grid-column: span var(--last-span-base);
}

@media (min-width: 640px) {
  .primitive-cell:last-child {
    grid-column: span var(--last-span-sm);
  }
}

@media (min-width: 1280px) {
  .primitive-cell:last-child {
    grid-column: span var(--last-span-xl);
  }
}

.primitive-tile {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 4.5rem;
  flex-direction: column;
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

/* The line field takes the tile color, so hover and focus change it the same way as text. */
.primitive-lines {
  color: var(--ui-text-muted);
  opacity: 0.65;
  transition: opacity 200ms ease, color 200ms ease;
}

.primitive-tile:focus-visible .primitive-lines {
  color: var(--ui-text-highlighted);
  opacity: 1;
}

@media (hover: hover) and (pointer: fine) {
  .primitive-tile:hover .primitive-lines {
    color: var(--ui-text-highlighted);
    opacity: 1;
  }
}

/* On phones the tiles with illustrations fill almost two screens. Show names only. */
@media (max-width: 639px) {
  .primitive-lines {
    display: none;
  }
}

@media (min-width: 640px) {
  /* The line field fills the top of the tile, so the name and description sit at the bottom. */
  .primitive-tile {
    min-height: 9rem;
    justify-content: flex-end;
    padding: 1.25rem;
  }

  /* Reserve two lines so names stay on one baseline when a description wraps. */
  .primitive-description {
    min-height: 2.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .primitive-lines {
    transition: none;
  }
}
</style>
