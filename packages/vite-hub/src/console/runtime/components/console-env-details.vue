<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ServerEnvDescriptionEntry } from "@vite-hub/env";

import ConsoleEnvManaged from "./console-env-managed.vue";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleStatus from "./console-status.vue";

const props = defineProps<{
  entry: ServerEnvDescriptionEntry;
  endpoint: string;
  /** The result of the last status check, when the page ran one. */
  status?: { label: string; tone: "error" | "neutral" | "success" | "warning" };
}>();
const properties = computed(() => [
  {
    label: "Source",
    value:
      props.entry.source === "env"
        ? "Host environment"
        : props.entry.source === "literal"
          ? "Application config"
          : props.entry.provider || "External provider",
  },
  ...(props.entry.type ? [{ label: "Type", mono: true, value: props.entry.type }] : []),
  { label: "Visibility", value: props.entry.secret ? "Secret" : "Server only" },
  { label: "Required", value: props.entry.required ? "Yes" : "No" },
  { label: "Default", value: props.entry.hasDefault ? "Configured" : "None" },
]);
const managing = ref(false);
watch(
  () => props.entry.path,
  () => {
    managing.value = false;
  },
);
</script>

<template>
  <div class="grid gap-6">
    <ConsoleStatus v-if="status" :label="status.label" :tone="status.tone" />
    <ConsolePropertyList title="Declaration" :items="properties" />
    <p class="text-[13px] leading-5 text-pretty text-muted">
      {{
        entry.source === "env"
          ? "Supplied by the host through environment variables or runtime bindings. Update it in your deployment configuration."
          : entry.source === "literal"
            ? "Defined in application configuration. Update it in your source code."
            : "Resolved through the configured provider when the application loads Server Env. Manage values in the connected store."
      }}
      <template v-if="!managing"> This view does not load values.</template>
    </p>
    <UButton
      v-if="entry.source === 'provider' && entry.path && !managing"
      class="justify-self-start"
      label="Manage credential"
      color="neutral"
      variant="outline"
      @click="managing = true"
    />
  </div>
  <ConsoleEnvManaged
    v-if="managing && entry.source === 'provider' && entry.path"
    :key="entry.path"
    :endpoint="endpoint"
    :path="entry.path"
  />
</template>
