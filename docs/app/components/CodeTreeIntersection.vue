<script setup lang="ts">
import { computed, inject, onMounted, ref, useTemplateRef } from "vue";
import type { Ref, VNode } from "vue";
import { useIntersectionObserver } from "@vueuse/core";

const props = defineProps<{
  /** Add the child block(s) to the tree on mount instead of waiting for intersection. */
  default?: boolean;
}>();

const slots = defineSlots<{ default: () => VNode[] }>();

const target = useTemplateRef<HTMLDivElement>("target");

const tree = inject<Ref<Record<string, unknown>>>("codeTree", ref({}));
const activePath = inject<Ref<string>>("codeTreeActive", ref(""));

const children = computed(() => (slots.default?.() || []).flatMap((node, i) => collectCodeBlocks(node, i)));

function findCodeBlock(slot: any): any {
  if (slot.props?.filename || slot.props?.label) return slot;
  if (slot.children?.default) {
    const defaultSlot = slot.children.default();
    for (const child of defaultSlot) {
      const found = findCodeBlock(child);
      if (found) return found;
    }
  }
  return null;
}

function collectCodeBlocks(slot: any, index = 0): Array<{ label: string; component: VNode }> {
  if (Array.isArray(slot)) return slot.flatMap((child, i) => collectCodeBlocks(child, i));
  if (typeof slot.type === "symbol") return collectCodeBlocks(slot.children || [], index);

  const codeBlock = findCodeBlock(slot);
  if (!codeBlock) return [];

  return [{
    label: codeBlock.props?.filename || codeBlock.props?.label || `${index}`,
    component: codeBlock,
  }];
}

function register() {
  for (const child of children.value) {
    tree.value[child.label] = child.component;
    activePath.value = child.label;
  }
}

onMounted(() => {
  if (props.default) return register();
  const rect = target.value?.getBoundingClientRect();
  if (rect && rect.top < window.innerHeight * 0.5) register();
});

useIntersectionObserver(
  target,
  ([entry]) => {
    if (entry?.isIntersecting) register();
  },
  { rootMargin: "0px 0px -60% 0px" },
);
</script>

<template>
  <div ref="target" class="lg:h-px">
    <div class="lg:hidden">
      <slot />
    </div>
  </div>
</template>
