<script setup lang="ts">
import type { ServerEnvDescriptionEntry } from "@vite-hub/env";

defineProps<{ entry: ServerEnvDescriptionEntry }>();
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
  <p class="mt-3 text-sm text-muted">Values are not loaded by this view.</p>
</template>
