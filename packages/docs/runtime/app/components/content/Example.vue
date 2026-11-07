<script setup lang="ts">
// `:::example`: rendered Markdown with its source a switch away, and an optional link that opens it in a playground.
// A site's parser puts the rendered copy in an `example-preview` node before the source, and writes `play`.
defineProps<{
  label?: string
  /** A playground URL that opens this example. */
  play?: string
}>()

const view = ref<"preview" | "code">("preview")
const seg = useTemplateRef<HTMLElement>("seg")
const thumb = ref<{ left: number, width: number, slide: boolean } | null>(null)

// The thumb slides under the pressed button. Its place is measured, because "Preview" and "Code" differ in width.
function place(slide = false) {
  const button = seg.value?.querySelector<HTMLElement>(`[data-view="${view.value}"]`)
  if (button?.offsetWidth) thumb.value = { left: button.offsetLeft, width: button.offsetWidth, slide }
}

// A switch in a hidden tab measures zero, so it's placed again, without sliding, whenever its size changes: when its
// tab opens or the font loads.
let resizes: ResizeObserver | undefined
watch(view, () => nextTick(() => place(true)))
onMounted(() => {
  resizes = new ResizeObserver(() => place())
  if (seg.value) resizes.observe(seg.value)
})
onBeforeUnmount(() => resizes?.disconnect())
</script>

<template>
  <div class="vh-example" :data-view="view">
    <div class="vh-example-bar">
      <a v-if="play" :href="play" class="vh-example-play">
        <UIcon name="i-lucide-flask-conical" class="size-3.5" />
        Playground
      </a>
      <div ref="seg" class="vh-seg" role="group" aria-label="View">
        <span v-if="thumb" class="vh-seg-thumb" :class="{ 'is-still': !thumb.slide }" :style="{ transform: `translateX(${thumb.left - 3}px)`, width: `${thumb.width}px` }" aria-hidden="true" />
        <button type="button" data-view="preview" :aria-pressed="view === 'preview'" :class="{ 'is-unmeasured': !thumb }" @click="view = 'preview'">Preview</button>
        <button type="button" data-view="code" :aria-pressed="view === 'code'" :class="{ 'is-unmeasured': !thumb }" @click="view = 'code'">Code</button>
      </div>
    </div>
    <div class="vh-example-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.vh-example {
  margin-block: 1.5rem;
}

/* A lone example puts its controls above the frame, at the right. In a group of examples they join the tab row. */
.vh-example-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.vh-example-play {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
  transition: color 150ms ease;
}

@media (hover: hover) {
  .vh-example-play:hover {
    color: var(--ui-text-highlighted);
  }
}

/* A segmented switch: a muted track and a raised thumb that slides to the pressed button. */
.vh-seg {
  position: relative;
  display: inline-flex;
  border-radius: 10px;
  background: var(--ui-bg-elevated);
  padding: 3px;
}

.vh-seg-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  border-radius: 6px;
  background: var(--vh-raised);
  box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.1);
  transition: transform 200ms var(--vh-ease-out), width 200ms var(--vh-ease-out);
}

.vh-seg button {
  position: relative;
  border-radius: 6px;
  padding: 0.2rem 0.65rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.5;
  transition: color 150ms ease;
}

/* Before the thumb is measured, the pressed button carries the raised surface itself. */
.vh-seg button.is-unmeasured[aria-pressed="true"] {
  background: var(--vh-raised);
  box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.1);
}

.vh-seg button[aria-pressed="true"] {
  color: var(--ui-text-highlighted);
}

@media (hover: hover) {
  .vh-seg button:hover {
    color: var(--ui-text-highlighted);
  }
}

.vh-seg button:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

@media (pointer: coarse) {
  .vh-seg button {
    min-height: 2.5rem;
    padding: 0.45rem 0.85rem;
  }
}

.vh-seg-thumb.is-still {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .vh-seg-thumb {
    transition: none;
  }
}

/* The preview sits in a hairline frame. The source shows in its own code block. */
.vh-example[data-view="preview"] > .vh-example-body > :deep(:not(.docs-example-preview)),
.vh-example[data-view="code"] > .vh-example-body > :deep(.docs-example-preview) {
  display: none;
}

.vh-example-body > :deep(.docs-example-preview) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px var(--ui-border);
  padding: 1.25rem 1.5rem;
}

/* Blocks add their own `style` and `script` elements, which aren't the first or last thing a reader sees. */
.vh-example-body > :deep(.docs-example-preview > :nth-child(1 of :not(style, script))) {
  margin-top: 0;
}

.vh-example-body > :deep(.docs-example-preview > :nth-last-child(1 of :not(style, script))) {
  margin-bottom: 0;
}

/* A block that draws its own frame (code, a chart, a diff, an embed, a callout, tabs, a carousel, a quiz) needs no
   second one around it, so a preview that holds only such blocks drops its ring and padding and stacks them with a gap.
   A block that only has an HTML renderer arrives in a `.comark-html` named after it. */
.vh-example-body > :deep(.docs-example-preview:not(:has(> :not(style, script, .cch, .cd, .ce, .ce-card, .cgc, .ck, .cft, .ct, .cmv, .cc, .ccr, .ccr-group, .cdg, .cmm, .cca, .cdt, .cdt-accordion, .ctr, .cfm, .cmt-tiles, .cqz, .cm-video, video.cm, .cn-notes, figure, pre, table, .comark-html:is([data-block="screenshot"], [data-block="compare"], [data-block="diff"], [data-block="question"], [data-block="poll"], [data-block="recall"]))))),
.vh-example-body > :deep(.docs-example-preview:has(> p > :is(.cm-video, .cm-audio))) {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-shadow: none;
  padding: 0;
}

.vh-example-body > :deep(.docs-example-preview > :is(.ca, .cch, .cd, .ce, .ce-card, .cgc, .ck, .cft, .ct, .cmv, .cc, .ccr, .ccr-group, .cdg, .cmm, .cca, .cdt, .cdt-accordion, .ctr, .cfm, .cmt-tiles, .cqz, .cm-video, video.cm, .cn-notes)),
.vh-example-body > :deep(.docs-example-preview > .comark-html > :is(.ca, .cd, .cqz)) {
  margin-block: 0;
}

.vh-example-body > :deep(:not(.docs-example-preview)) {
  margin-block: 0;
}
</style>
