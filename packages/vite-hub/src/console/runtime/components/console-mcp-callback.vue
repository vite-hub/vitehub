<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { consoleMcpAccount, requestConsoleMcp } from "../client/mcp-client";
import { useConsoleToast } from "../client/toast";
import ConsoleFrame from "./console-frame.vue";
import ConsoleState from "./console-state.vue";

/**
 * Where an authorization server sends the browser after an MCP sign-in. The page hands the code to the server, which
 * exchanges it with the PKCE verifier that never left the server, then opens the new connection. The code leaves the
 * address bar as soon as the page has read it.
 */
const props = defineProps<{ sectionsBase: string }>();

const route = useRoute();
const router = useRouter();
const toast = useConsoleToast();
const error = ref<unknown>();

function query(name: string): string | undefined {
  const value = route.query[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first ? first : undefined;
}

onMounted(async () => {
  const input = {
    code: query("code"),
    error: query("error"),
    errorDescription: query("error_description"),
    iss: query("iss"),
    state: query("state") ?? "",
  };
  // Keep the code out of the history, whatever happens next.
  await router.replace({ name: "vitehub-console-mcp-client-callback" });
  try {
    const connection = await requestConsoleMcp(props.sectionsBase, "mcp-client.complete", Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
    toast.show({ title: `Connected as ${consoleMcpAccount(connection).primary}` });
    await router.replace({ name: "vitehub-console-mcp-client", query: { connection: connection.id } });
  }
  catch (cause) {
    error.value = cause;
  }
});
</script>

<template>
  <ConsoleFrame active="mcp-client" :sections-base="sectionsBase">
    <UDashboardPanel id="mcp-client-callback" :ui="{ body: 'grid min-h-0 place-items-center p-6' }">
      <ConsoleState
        v-if="error"
        :error="error"
        title="Couldn't finish the sign-in"
        :actions="[{ label: 'Back to MCP client', icon: 'i-lucide-arrow-left', to: { name: 'vitehub-console-mcp-client' } }]"
      />
      <div v-else class="grid justify-items-center gap-3 text-center" role="status" aria-live="polite">
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted motion-reduce:animate-none" aria-hidden="true" />
        <p class="text-[13px] text-muted">Finishing the sign-in…</p>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
