<script setup lang="ts">
// `::examples`: one tab per `:::example`. Each example's Playground link and Preview and Code switch sit at the end of
// the tab row.
import type { VNode } from "vue"

const slots = useSlots()
const items = computed(() => (slots.default?.() ?? []).filter((node: VNode) => typeof node.type === "object"))
const labels = computed(() => items.value.map((node, at) => String(node.props?.label ?? `Example ${at + 1}`)))
const active = ref(0)
// Mount each preview on first use, then retain its state between tabs.
const opened = ref(new Set([0]))
// One view for every example, so Code stays on when the reader changes tabs.
const view = ref<"preview" | "code">("preview")
const id = useId()
const list = useTemplateRef<HTMLElement>("list")
const line = ref<{ left: number, width: number, slide: boolean } | null>(null)

// One line slides under the open tab. Its place is measured, because the labels differ in width.
function place(slide = false) {
  const tab = list.value?.querySelectorAll<HTMLElement>("[role=tab]")[active.value]
  if (tab?.offsetWidth) line.value = { left: tab.offsetLeft, width: tab.offsetWidth, slide }
}

function select(at: number, focus = false) {
  active.value = (at + labels.value.length) % labels.value.length
  opened.value.add(active.value)
  if (focus) nextTick(() => list.value?.querySelectorAll<HTMLElement>("[role=tab]")[active.value]?.focus())
}

// Arrow keys move between the tabs, and Home and End jump to the ends, as in a native tab list.
function onKeydown(event: KeyboardEvent) {
  const keys: Record<string, number> = { ArrowRight: active.value + 1, ArrowLeft: active.value - 1, Home: 0, End: labels.value.length - 1 }
  if (!(event.key in keys)) return
  event.preventDefault()
  select(keys[event.key]!, true)
}

// Tabs inside a hidden block measure zero, so the line is placed again, without sliding, whenever the row's size
// changes: when the block opens or the font loads.
let resizes: ResizeObserver | undefined
watch(active, () => nextTick(() => place(true)))
onMounted(() => {
  resizes = new ResizeObserver(() => place())
  if (list.value) resizes.observe(list.value)
})
onBeforeUnmount(() => resizes?.disconnect())
</script>

<template>
  <div class="vh-examples">
    <div ref="list" role="tablist" class="vh-examples-tabs" @keydown="onKeydown">
      <button
        v-for="(label, at) in labels"
        :id="`${id}-tab-${at}`"
        :key="label"
        type="button"
        role="tab"
        :aria-selected="at === active"
        :aria-controls="`${id}-panel-${at}`"
        :tabindex="at === active ? 0 : -1"
        :class="{ 'is-unmeasured': !line }"
        @click="select(at)"
      >
        {{ label }}
      </button>
      <span v-if="line" class="vh-examples-line" :class="{ 'is-still': !line.slide }" :style="{ transform: `translateX(${line.left}px) scaleX(${line.width})` }" aria-hidden="true" />
    </div>
    <div
      v-for="(item, at) in items"
      v-show="at === active"
      :id="`${id}-panel-${at}`"
      :key="at"
      role="tabpanel"
      :aria-labelledby="`${id}-tab-${at}`"
      class="vh-examples-panel"
    >
      <component :is="item" v-if="opened.has(at)" v-model:view="view" />
    </div>
  </div>
</template>

<style scoped>
.vh-examples {
  position: relative;
  margin: 2.5rem 0 1.5rem;
}

/* Plain labels with no rule under the row. The open tab is the one with the line. Room is kept at the end for the
   controls of the open example. */
.vh-examples-tabs {
  position: relative;
  display: flex;
  gap: 1.25rem;
  margin: 0 15.5rem 0.75rem 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.vh-examples-tabs > button {
  flex: none;
  border-bottom: 1px solid transparent;
  padding: 0.5rem 0;
  color: var(--ui-text-dimmed);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5;
  transition: color 150ms ease;
}

.vh-examples-tabs > button[aria-selected="true"] {
  color: var(--ui-text-highlighted);
}

.vh-examples-tabs > button.is-unmeasured[aria-selected="true"] {
  border-bottom-color: var(--ui-text-highlighted);
}

@media (pointer: coarse) {
  .vh-examples-tabs > button {
    min-height: 2.75rem;
  }
}

@media (hover: hover) {
  .vh-examples-tabs > button:hover {
    color: var(--ui-text-highlighted);
  }
}

/* A 1px line scaled to the tab's width, so the slide only moves a transform. */
.vh-examples-line {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 1px;
  height: 1px;
  background: var(--ui-text-highlighted);
  transform-origin: left;
  transition: transform 200ms var(--vh-ease-out);
}

.vh-examples-panel > :deep(.vh-example) {
  margin-block: 0;
}

.vh-examples-panel :deep(.vh-example-bar) {
  position: absolute;
  top: 0.3rem;
  right: 0;
  margin: 0;
}

/* On a narrow page the controls take their own row under the tabs. */
@media (width < 40rem) {
  .vh-examples-tabs {
    margin-right: 0;
  }

  .vh-examples-panel :deep(.vh-example-bar) {
    position: static;
    margin-bottom: 0.5rem;
  }
}

.vh-examples-line.is-still {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .vh-examples-line {
    transition: none;
  }
}
</style>
