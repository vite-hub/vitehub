<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { contentHeadStatus, contentWebhookResult, readContentHeads, shortCommit } from "../client/content-heads";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSection from "./console-section.vue";
import ConsoleState from "./console-state.vue";

import type { ConsoleContentHead } from "../client/content-heads";

/**
 * The `github()` Sources of Content on its dashboard: the commit that each one serves, whether a pin holds it, and the
 * last push webhook. It reads `content.head`, the operation of `vitehub content head`, and hides itself when the app
 * has no `github()` Source.
 */
const heads = ref<ConsoleContentHead[]>();
const error = ref<unknown>();
const loading = ref(false);
let controller: AbortController | undefined;

async function load(): Promise<void> {
  controller?.abort();
  const current = controller = new AbortController();
  loading.value = true;
  error.value = undefined;
  try {
    heads.value = await readContentHeads(current.signal);
  }
  catch (loadError) {
    if (current.signal.aborted) return;
    error.value = loadError;
  }
  finally {
    if (controller === current) loading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ConsoleSection v-if="error || heads?.length" title="Sources" :count="heads && heads.length > 1 ? heads.length : undefined">
    <ConsoleState v-if="error" compact :error="error" title="Couldn't load the Source heads" :retry="load" />
    <ul v-else class="grid gap-4" :aria-busy="loading">
      <li v-for="head in heads" :key="head.source" class="grid gap-1" :aria-label="`Source ${head.source}`">
        <div class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ head.source }}</span>
          <Status :tone="contentHeadStatus(head).tone" :label="contentHeadStatus(head).label" />
        </div>
        <p class="truncate text-xs text-muted">
          <template v-if="head.sha">
            <span v-if="head.ref">{{ head.ref }} at </span><span class="font-mono text-default" :title="head.sha">{{ shortCommit(head.sha) }}</span>
            <template v-if="head.movedAt">, moved <ConsoleRelativeTime :value="head.movedAt" /></template>
          </template>
          <template v-else>No commit served yet</template>
        </p>
        <p class="truncate text-xs text-muted" :title="head.webhook?.error">
          <template v-if="head.webhook">
            Last push <ConsoleRelativeTime :value="head.webhook.at" />:
            <span :class="contentWebhookResult(head.webhook).tone === 'error' ? 'text-error' : 'text-default'">{{ contentWebhookResult(head.webhook).label }}</span>
          </template>
          <span v-else class="text-dimmed">No push webhook yet</span>
        </p>
        <p v-if="head.diagnostic" class="text-xs text-muted">
          <span class="text-default">{{ head.diagnostic.message }}</span> {{ head.diagnostic.fix }}
        </p>
      </li>
    </ul>
  </ConsoleSection>
</template>
