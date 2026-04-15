<script setup lang="ts">
import { computed, inject, useAttrs } from "vue";
import { useDocsRenderMode } from "../composables/useDocsRenderMode";
import { useFrameworkPreference } from "../composables/useFrameworkPreference";
import { useUsageModePreference } from "../composables/useUsageModePreference";
import {
  createFwVariant,
  fwGroupContextKey,
  type FwGroupContext,
  getFwVariantIdFromProps,
  getFwVariantsFromProps,
  matchesFwVariant,
} from "~~/modules/vitehub-docs/runtime/utils/fw-variants";

const props = defineProps<{ id?: string }>();

const { current: framework } = useFrameworkPreference();
const { current: mode } = useUsageModePreference();
const { renderMode } = useDocsRenderMode();
const group = inject<FwGroupContext | null>(fwGroupContextKey, null);
const attrs = useAttrs();

const variantProps = computed(() => ({
  ...attrs,
  ...(props.id ? { id: props.id } : {}),
}));
const variantId = computed(() => getFwVariantIdFromProps(variantProps.value));
const variants = computed(() => getFwVariantsFromProps(variantProps.value));
const visible = computed(() => {
  if (variants.value.length === 0) {
    return false;
  }

  if (group?.selectedId) {
    return group.selectedId.value === variantId.value;
  }

  if (renderMode.value === "all") {
    return true;
  }

  return matchesFwVariant(variants.value, createFwVariant(framework.value, mode.value));
});
</script>

<template>
  <div v-if="visible">
    <slot />
  </div>
</template>
