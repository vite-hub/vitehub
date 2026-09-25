<script setup lang="ts">
import { ref, watch } from "vue";
import type { ServerEnvDescriptionEntry } from "@vite-hub/env";

import ConsoleEnvManaged from "./console-env-managed.vue";

const props = defineProps<{ entry: ServerEnvDescriptionEntry; endpoint: string }>();
const managing = ref(false);
watch(
  () => props.entry.path,
  () => {
    managing.value = false;
  },
);
</script>

<template>
  <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-4 text-sm">
    <dt class="text-muted">Source</dt>
    <dd class="break-words text-highlighted">
      {{
        entry.source === "env"
          ? "Host environment"
          : entry.source === "literal"
            ? "Application config"
            : entry.provider || "External provider"
      }}
    </dd>
    <dt class="text-muted">Value</dt>
    <dd>{{ entry.secret ? "Secret" : "Server only" }}</dd>
    <dt class="text-muted">Required</dt>
    <dd>{{ entry.required ? "Yes" : "No" }}</dd>
    <dt class="text-muted">Default</dt>
    <dd>{{ entry.hasDefault ? "Configured" : "None" }}</dd>
  </dl>
  <p class="mt-8 text-sm text-muted">
    {{
      entry.source === "env"
        ? "Supplied by the host through environment variables or runtime bindings. Update it in your deployment configuration."
        : entry.source === "literal"
          ? "Defined in application configuration. Update it in your source code."
          : "Resolved through the configured provider when the application loads Server Env. Manage values in the connected store."
    }}
  </p>
  <p v-if="!managing" class="mt-3 text-sm text-muted">Values are not loaded by this view.</p>
  <UButton
    v-if="entry.source === 'provider' && entry.path && !managing"
    class="mt-5"
    label="Manage credential"
    color="neutral"
    variant="outline"
    @click="managing = true"
  />
  <ConsoleEnvManaged
    v-if="managing && entry.source === 'provider' && entry.path"
    :key="entry.path"
    :endpoint="endpoint"
    :path="entry.path"
  />
</template>
