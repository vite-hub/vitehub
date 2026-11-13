<script setup lang="ts">
import { usePreferredReducedMotion } from "@vueuse/core";
import type { HeroCaption, HeroFigure } from "~/utils/hero-figure";
import { heroFigures, isHeroFigureName } from "~/utils/hero-figure";
import "~/assets/hero-figure.css";

// `:hero-figure{name="kv"}` is the animated figure on the right of a primitive landing page. The scene draws a
// short story of the primitive that loops. It pauses off screen and with the button, and readers who turn motion
// off see one still frame with a summary.

const props = defineProps<{
  /** The primitive, such as "queue" or "kv". It names a scene in `app/utils/hero-figure/scenes`. */
  name: string;
}>();

const host = useTemplateRef<HTMLElement>("host");
const reducedMotion = usePreferredReducedMotion();
const caption = ref<HeroCaption | null>(null);
const label = ref("");
const paused = ref(false);
let figure: HeroFigure | undefined;

onMounted(async () => {
  if (!isHeroFigureName(props.name)) throw new Error(`No hero figure named "${props.name}".`);
  const mount = await heroFigures[props.name]();
  if (!host.value) return;
  const mounted = mount(host.value, {
    reduce: reducedMotion.value === "reduce",
    onCaption: (next) => {
      caption.value = next;
    },
  });
  figure = mounted.figure;
  label.value = mounted.label;
});

onBeforeUnmount(() => figure?.destroy());

function toggle() {
  paused.value = !paused.value;
  if (paused.value) figure?.pause();
  else figure?.play();
}
</script>

<template>
  <figure class="vh-hero-figure not-prose">
    <div ref="host" class="vh-hero-figure-stage" role="img" :aria-label="label || undefined" />
    <figcaption class="vh-hero-figure-caption">
      <span :key="caption?.text" class="vh-hero-figure-text">{{ caption?.text }}</span>
      <div v-if="caption && !caption.still" class="vh-hero-figure-progress">
        <span class="vh-hero-figure-steps" aria-hidden="true">
          <i v-for="index in caption.steps" :key="index" :class="{ 'is-on': index - 1 <= caption.step }" />
        </span>
        <UButton
          variant="ghost"
          size="xs"
          color="neutral"
          :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
          :aria-label="paused ? 'Play the animation' : 'Pause the animation'"
          @click="toggle"
        />
      </div>
    </figcaption>
  </figure>
</template>

<style scoped>
.vh-hero-figure {
  margin: 0;
}

/* Keeps room for the figure before its scene loads, so the page does not jump. */
.vh-hero-figure-stage:empty {
  min-height: 12rem;
}

.vh-hero-figure-caption {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
  min-height: 3rem;
  margin-top: 1.25rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.5;
}

.vh-hero-figure-text {
  text-wrap: pretty;
  animation: vh-hero-figure-in 250ms cubic-bezier(0.23, 1, 0.32, 1);
}

.vh-hero-figure-progress {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
}

.vh-hero-figure-steps {
  display: flex;
  gap: 0.25rem;
}

.vh-hero-figure-steps i {
  width: 0.875rem;
  height: 2px;
  border-radius: 2px;
  background: var(--ui-border-accented);
  transition: background-color 200ms ease;
}

.vh-hero-figure-steps i.is-on {
  background: var(--ui-text-highlighted);
}

@keyframes vh-hero-figure-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .vh-hero-figure-text {
    animation: none;
  }
}
</style>
