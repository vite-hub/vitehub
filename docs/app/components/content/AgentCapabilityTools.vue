<script setup lang="ts">
import capabilityReferences from "#vitehub-capability-references";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    name: string;
    variant?: string;
  }>(),
  {
    variant: "default",
  },
);

const reference = computed(() => capabilityReferences[`${props.name}.${props.variant}`]);
</script>

<template>
  <div class="not-prose my-5 rounded-lg border border-default bg-default p-2">
    <AgentToolList v-if="reference" :tools="reference.tools" />
    <p v-else class="m-2 text-sm text-muted">
      No build-time tool contract exists for {{ name }}.{{ variant }}.
    </p>
  </div>
</template>
