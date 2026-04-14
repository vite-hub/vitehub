<script setup lang="ts">
import { Fragment, computed, provide, ref, watch, type VNode } from "vue";
import type { AstNode } from "~~/modules/vitehub-docs/runtime/utils/framework-content";
import { useFrameworkPreference } from "~/composables/useFrameworkPreference";
import { useUsageModePreference } from "~/composables/useUsageModePreference";
import {
  fwGroupContextKey,
  getFwVariantTabScore,
  parseFwVariants,
  usageModeLabels,
} from "~~/modules/vitehub-docs/runtime/utils/fw-variants";
import {
  frameworkColorIcons,
  frameworkLabels,
} from "~~/modules/vitehub-docs/runtime/utils/frameworks";

type FrameworkTabItem = {
  id: string;
  variants: ReturnType<typeof parseFwVariants>;
  body?: {
    type: "root";
    children: AstNode[];
  };
};

const props = defineProps<{
  items?: Array<{
    id: string;
    body?: {
      type: "root";
      children: AstNode[];
    };
  }>;
}>();

const { current: framework } = useFrameworkPreference();
const { current: mode } = useUsageModePreference();

const slots = defineSlots<{
  default?: () => VNode[];
}>();

function flattenVNodes(children: VNode[] | undefined): VNode[] {
  return (children || []).flatMap((node) => {
    if (node.type === Fragment) {
      return flattenVNodes(Array.isArray(node.children) ? node.children as VNode[] : []);
    }

    return [node];
  });
}

const items = computed<FrameworkTabItem[]>(() => {
  if (props.items?.length) {
    return props.items
      .filter(item => item.id)
      .map((item) => {
        return {
          id: item.id,
          body: item.body,
          variants: parseFwVariants(item.id),
        };
      })
      .filter(item => item.variants.length > 0);
  }

  return flattenVNodes(slots.default?.())
    .map((node) => {
      const id = String(node.props?.id || "");
      return {
        id,
      };
    })
    .filter(item => item.id)
    .map((item) => {
      return {
        id: item.id,
        variants: parseFwVariants(item.id),
      };
    })
    .filter(item => item.variants.length > 0);
});

function getDefaultTabId() {
  const currentVariant = { framework: framework.value, mode: mode.value };

  return [...items.value]
    .sort((left, right) => getFwVariantTabScore(left.variants, currentVariant) - getFwVariantTabScore(right.variants, currentVariant))
    .map(item => item.id)[0] || null;
}

const selectedId = ref<string | null>(null);

watch(
  [items, framework, mode],
  () => {
    selectedId.value = getDefaultTabId();
  },
  { immediate: true },
);

provide(fwGroupContextKey, { selectedId });

function selectTab(id: string) {
  selectedId.value = id;
}

const selectedItem = computed(() => {
  return items.value.find(item => item.id === selectedId.value) || items.value[0] || null;
});

function labelForItem(item: FrameworkTabItem) {
  return item.variants
    .map(variant => `${frameworkLabels[variant.framework]} ${usageModeLabels[variant.mode]}`)
    .join(" + ");
}

function modeLabelForItem(item: FrameworkTabItem) {
  const firstMode = item.variants[0]?.mode;
  if (!firstMode) {
    return "";
  }

  return item.variants.every(variant => variant.mode === firstMode)
    ? usageModeLabels[firstMode]
    : item.variants.map(variant => usageModeLabels[variant.mode]).join(" + ");
}

function frameworksForItem(item: FrameworkTabItem) {
  return item.variants
    .map(variant => variant.framework)
    .filter((framework, index, items) => items.indexOf(framework) === index);
}
</script>

<template>
  <div class="fw-group">
    <div class="fw-group__tabs not-prose" role="tablist" aria-orientation="horizontal">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="tab"
        class="fw-group__tab"
        :class="{ 'fw-group__tab--active': selectedId === item.id }"
        :aria-selected="selectedId === item.id"
        :title="labelForItem(item)"
        @click="selectTab(item.id)"
      >
        <span class="fw-group__tab-icons" :data-shared="frameworksForItem(item).length > 1 ? 'true' : 'false'">
          <template v-for="itemFramework in frameworksForItem(item)" :key="itemFramework">
            <UIcon :name="frameworkColorIcons[itemFramework]" class="fw-group__tab-icon" />
          </template>
        </span>
        <span class="sr-only">{{ modeLabelForItem(item) }}</span>
      </button>
    </div>

    <MDCRenderer
      v-if="selectedItem?.body"
      :body="selectedItem.body"
      :data="{}"
    />
    <slot v-else />
  </div>
</template>
