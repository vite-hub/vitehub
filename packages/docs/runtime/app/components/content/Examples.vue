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
const tabs = computed(() => labels.value.map((label, at) => ({ label, value: at })))

watch(active, (at) => opened.value.add(at))
</script>

<template>
  <div class="vh-examples">
    <UTabs v-model="active" :items="tabs" :content="false" class="vh-examples-tabs" aria-label="Examples" />
    <div
      v-for="(item, at) in items"
      v-show="at === active"
      :key="at"
      role="tabpanel"
      :aria-label="labels[at]"
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

/* The theme's underline tabs. Room is kept at the end for the controls of the open example. */
.vh-examples-tabs {
  margin: 0 15.5rem 0.75rem 0;
  overflow-x: auto;
  scrollbar-width: none;
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

</style>
