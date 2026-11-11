<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { landingPrimitives } from "./content";

type PrimitiveId = (typeof landingPrimitives)[number]["id"];

const grid = useTemplateRef<HTMLElement>("grid");
const visible = ref(false);
const activeId = ref<PrimitiveId | null>(null);
const indicator = useSharedIndicator(grid);
watch(activeId, (id) => {
  if (!id) indicator.reset();
});

useIntersectionObserver(grid, ([entry]) => {
  visible.value = entry?.isIntersecting ?? false;
});
</script>

<template>
  <div id="primitives">
    <ul
      ref="grid"
      class="primitive-grid grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-7"
      aria-label="ViteHub APIs"
      @pointerleave="activeId = null"
    >
      <li
        v-for="(primitive, index) in landingPrimitives"
        :key="primitive.id"
        class="primitive-cell min-w-0"
      >
        <NuxtLink
          :to="primitive.to"
          data-focus-inset
          class="primitive-tile group"
          @pointerenter="activeId = primitive.id"
        >
          <div
            v-if="activeId === primitive.id"
            :ref="indicator.track"
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
            <p class="mt-0.5 truncate text-xs/5 text-muted">{{ primitive.description }}</p>
          </div>
        </NuxtLink>
      </li>
    </ul>
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
  min-height: 4.5rem;
  flex-direction: column;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 1rem 1.25rem;
  background: var(--ui-bg);
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
    min-height: 7rem;
    justify-content: flex-end;
    padding: 1rem 1.25rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .primitive-lines {
    transition: none;
  }
}
</style>
