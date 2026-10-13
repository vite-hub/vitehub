<script setup lang="ts">
import type { ExamplePreview } from "~/data/examples";

defineProps<{ preview: ExamplePreview }>();
</script>

<template>
  <figure class="min-w-0">
    <div
      v-if="preview.kind === 'screenshot'"
      class="flex aspect-[8/5] items-center border-b border-default bg-elevated p-4"
    >
      <img
        :src="preview.src"
        :alt="preview.alt"
        width="1280"
        height="720"
        loading="lazy"
        class="w-full rounded-md border border-default"
      />
    </div>
    <div
      v-else
      role="img"
      :aria-label="preview.alt"
      class="aspect-[8/5] overflow-hidden border-b border-default bg-elevated p-4"
    >
      <div
        aria-hidden="true"
        class="h-full overflow-hidden rounded-md border border-default bg-default"
      >
        <div
          class="flex h-9 items-center justify-between gap-2 border-b border-default px-3 text-xs"
        >
          <span class="flex items-center gap-1.5 font-semibold text-highlighted">
            <UIcon
              :name="preview.app === 'drop' ? 'i-lucide-file-text' : 'i-lucide-utensils'"
              class="size-3.5"
            />
            {{ preview.app === "drop" ? "Drop" : "Calories" }}
          </span>
          <span class="text-muted">{{
            preview.app === "drop" ? "Private review" : "Meal journal"
          }}</span>
        </div>

        <div v-if="preview.app === 'drop'" class="grid h-full grid-cols-5">
          <div class="col-span-3 min-w-0 border-r border-default p-3">
            <p class="text-xs font-semibold text-highlighted">Website launch plan</p>
            <p class="mt-1 text-[10px] text-muted">Version 2 · Draft</p>
            <p class="mt-4 text-[10px] font-medium text-highlighted">Before we launch</p>
            <p class="mt-2 text-[10px] leading-5 text-muted">
              Check the sign-in flow and invite the first reviewers.
              <span class="bg-primary/15 text-highlighted">Share a private review link.</span>
            </p>
            <div class="mt-3 space-y-1.5">
              <div class="h-1 w-full rounded bg-muted" />
              <div class="h-1 w-4/5 rounded bg-muted" />
              <div class="h-1 w-3/5 rounded bg-muted" />
            </div>
          </div>
          <div class="col-span-2 min-w-0 bg-elevated/50 p-2.5">
            <p class="text-[10px] font-medium text-highlighted">Comments</p>
            <div class="mt-3 rounded border border-default bg-default p-2">
              <p class="text-[10px] font-semibold text-highlighted">Alex</p>
              <p class="mt-1 text-[10px] leading-4 text-muted">
                Can reviewers comment without editing the plan?
              </p>
            </div>
            <p class="mt-2 text-[10px] text-muted">1 open comment</p>
          </div>
        </div>

        <div v-else class="p-3">
          <div class="flex items-baseline justify-between">
            <p class="text-xs font-semibold text-highlighted">Today</p>
            <p class="text-[10px] text-muted">2 meals</p>
          </div>
          <div
            class="mt-2 grid grid-cols-2 gap-3 rounded border border-default bg-elevated/50 p-2.5"
          >
            <div>
              <p class="text-[10px] text-muted">Calories</p>
              <p class="mt-1 text-sm font-semibold tabular-nums text-highlighted">
                860 <span class="text-[10px] font-normal text-muted">/ 2,000 kcal</span>
              </p>
              <div class="mt-2 h-1 rounded-full bg-muted">
                <div class="h-full w-2/5 rounded-full bg-primary" />
              </div>
            </div>
            <div>
              <p class="text-[10px] text-muted">Protein</p>
              <p class="mt-1 text-sm font-semibold tabular-nums text-highlighted">
                54 <span class="text-[10px] font-normal text-muted">/ 120 g</span>
              </p>
              <div class="mt-2 h-1 rounded-full bg-muted">
                <div class="h-full w-1/2 rounded-full bg-primary" />
              </div>
            </div>
          </div>
          <div class="mt-3 space-y-2 text-[10px]">
            <div class="flex items-center justify-between gap-2">
              <span class="text-highlighted">Yogurt and oats</span>
              <span class="tabular-nums text-muted">320 kcal · 18 g</span>
            </div>
            <div class="flex items-center justify-between gap-2 border-t border-default pt-2">
              <span class="text-highlighted">Chicken rice bowl</span>
              <span class="tabular-nums text-muted">540 kcal · 36 g</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <figcaption class="px-4 pt-2 text-xs text-dimmed">
      <a
        v-if="preview.kind === 'screenshot'"
        :href="preview.source"
        target="_blank"
        rel="noopener noreferrer"
        class="rounded underline decoration-default underline-offset-2 hover:text-muted focus-visible:outline-2 focus-visible:outline-primary"
        >Screenshot from the project</a
      >
      <template v-else>App mockup · Sample content</template>
    </figcaption>
  </figure>
</template>
