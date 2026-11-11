<script setup lang="ts">
import examples from "#docs/examples"

// `:::example`: a preview with its source a switch away, and an optional link that opens it in a playground. Around a
// Markdown code block, the parser put the rendered Markdown in an `example-preview` node before the source. With
// `name`, the preview is the Vue file of that name in the examples folder, and the parser made its source the code.
const props = defineProps<{
  label?: string
  /** A playground URL that opens this example. */
  play?: string
  /** A Vue file in the examples folder, without `.vue`. */
  name?: string
  /** The height, in rem, that a Vue example keeps before its module loads. Markdown writes it as a string. */
  height?: number | string
  /** Show a Vue example edge to edge, at a fixed height, for chats and dashboards. */
  flush?: boolean
  /** Show a Reset control that mounts a Vue example again with its first state. */
  reset?: boolean
}>()

// `::examples` passes its view in, so the next tab opens in the view the reader picked.
const view = defineModel<"preview" | "code">("view", { default: "preview" })
const loader = props.name ? examples[props.name] : undefined
const live = loader ? defineAsyncComponent(loader) : undefined
const mounts = ref(0)
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
      <p v-if="$slots.title" class="vh-example-title"><slot name="title" /></p>
      <a v-if="play" :href="play" class="vh-example-play">
        <UIcon name="i-lucide-flask-conical" class="size-3.5" />
        Playground
      </a>
      <button v-if="live && reset" type="button" class="vh-example-play" @click="mounts++">
        <UIcon name="i-lucide-rotate-ccw" class="size-3.5" />
        Reset
      </button>
      <div ref="seg" class="vh-seg" role="group" aria-label="View">
        <span v-if="thumb" class="vh-seg-thumb" :class="{ 'is-still': !thumb.slide }" :style="{ transform: `translateX(${thumb.left - 3}px)`, width: `${thumb.width}px` }" aria-hidden="true" />
        <button type="button" data-focus-inset data-view="preview" :aria-pressed="view === 'preview'" :class="{ 'is-unmeasured': !thumb }" @click="view = 'preview'">Preview</button>
        <button type="button" data-focus-inset data-view="code" :aria-pressed="view === 'code'" :class="{ 'is-unmeasured': !thumb }" @click="view = 'code'">Code</button>
      </div>
    </div>
    <div class="vh-example-body">
      <div
        v-if="live"
        class="docs-example-preview vh-example-live"
        :class="{ 'is-flush': flush }"
        :style="height ? { '--vh-example-height': `${height}rem` } : undefined"
      >
        <Suspense>
          <component :is="live" :key="mounts" />
          <template #fallback>
            <div role="status" class="vh-example-loading">Loading preview…</div>
          </template>
        </Suspense>
      </div>
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

/* A title, such as Correct or Incorrect on a lint rule's examples, leads the bar. */
.vh-example-title {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0 auto 0 0;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
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
  border-radius: calc(var(--ui-radius) * 2);
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
  box-shadow: 0 0 0 1px var(--ui-border);
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
  box-shadow: 0 0 0 1px var(--ui-border);
}

.vh-seg button[aria-pressed="true"] {
  color: var(--ui-text-highlighted);
}

@media (hover: hover) {
  .vh-seg button:hover {
    color: var(--ui-text-highlighted);
  }
}


/* Touch screens get 44px targets. */
@media (pointer: coarse) {
  .vh-seg button {
    min-height: 2.75rem;
    padding: 0.45rem 0.85rem;
  }

  .vh-example-play {
    min-height: 2.75rem;
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
.vh-example[data-view="preview"] > .vh-example-body:has(> .docs-example-preview) > :deep(:not(.docs-example-preview)),
.vh-example[data-view="code"] > .vh-example-body > :deep(.docs-example-preview) {
  display: none;
}

.vh-example-body > :deep(.docs-example-preview) {
  border-radius: calc(var(--ui-radius) * 2);
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

/* A block that draws its own frame (code, a chart, a table, a diff, an embed, a callout, tabs, a carousel, a quiz) needs no
   second one around it, so a preview that holds only such blocks drops its ring and padding and stacks them with a gap.
   A block that only has an HTML renderer arrives in a `.comark-html` named after it. */
.vh-example-body > :deep(.docs-example-preview:not(:has(> :not(style, script, .cch, .cd, .ce, .ce-card, .cgc, .ck, .cft, .ct, .cmv, .cc, .ccr, .ccr-group, .cdg, .cmm, .cca, .cdt, .cdt-accordion, .ctr, .cfm, .cmt-tiles, .cqz, .cm-video, video.cm, .cn-notes, .ctb, figure, pre, table, .comark-html:is([data-block="screenshot"], [data-block="compare"], [data-block="diff"], [data-block="question"], [data-block="poll"], [data-block="recall"]))))),
.vh-example-body > :deep(.docs-example-preview:has(> p > :is(.cm-video, .cm-audio))) {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-shadow: none;
  padding: 0;
}

.vh-example-body > :deep(.docs-example-preview > :is(.ca, .cch, .cd, .ce, .ce-card, .cgc, .ck, .cft, .ct, .cmv, .cc, .ccr, .ccr-group, .cdg, .cmm, .cca, .cdt, .cdt-accordion, .ctr, .cfm, .cmt-tiles, .cqz, .cm-video, video.cm, .cn-notes, .ctb)),
.vh-example-body > :deep(.docs-example-preview > .comark-html > :is(.ca, .cd, .cqz)) {
  margin-block: 0;
}

.vh-example-body > :deep(:not(.docs-example-preview)) {
  margin-block: 0;
}

/* A Vue example keeps its height before its module loads. The height is a minimum, so text that wraps on a narrow
   screen grows the frame. A flush example fills a fixed height edge to edge, as a chat fills its parent. */
.vh-example-live {
  min-width: 0;
  min-height: calc(var(--vh-example-height, 0rem) + 2.5rem);
  overflow-x: auto;
}

.vh-example-live.is-flush {
  height: var(--vh-example-height, auto);
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.vh-example-loading {
  display: grid;
  min-height: var(--vh-example-height, 4rem);
  place-items: center;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}
</style>
