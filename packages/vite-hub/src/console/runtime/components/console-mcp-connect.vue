<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { consoleMcpEndpoint, requestConsoleMcp } from "../client/mcp-client";
import ConsoleState from "./console-state.vue";

import type { ConsoleMcpCandidate, ConsoleMcpConnection } from "../mcp-client";

/**
 * Connect to an MCP server. OAuth needs nothing from the person until the server asks for it: the authorization
 * server of the app's own `/mcp` sees the session of this browser, so a signed-in person only approves the client.
 * A token is the fallback for servers without OAuth, or to act as someone whose sign-in this browser does not have.
 */
const props = defineProps<{
  base: string;
  /** Fill the form for this server, such as "Add an account" on a server in the sidebar. */
  preset?: { another?: boolean, server: string };
  servers: readonly ConsoleMcpCandidate[];
  /** The Console uses the app's own sign-in. See `ConsoleMcpOverview.sharedSession`. */
  sharedSession: boolean;
}>();

const emit = defineEmits<{ connected: [connection: ConsoleMcpConnection] }>();
const open = defineModel<boolean>("open", { required: true });

const server = ref("");
const method = ref<"oauth" | "token">("oauth");
const another = ref(false);
const token = ref("");
const label = ref("");
const pending = ref(false);
const error = ref<unknown>();

const sameOrigin = computed(() => {
  try {
    return new URL(server.value.trim() || "/", window.location.origin).origin === window.location.origin;
  }
  catch {
    return false;
  }
});
// Signing in as someone else at this origin would also replace the Console's own session.
const anotherBlocked = computed(() => props.sharedSession && sameOrigin.value);
const methods = [
  { description: "Sign in at the server's authorization server. A server without sign-in connects at once.", label: "OAuth", value: "oauth" },
  { description: "Paste a personal API key or another bearer token.", label: "Token", value: "token" },
];
const canSubmit = computed(() => Boolean(server.value.trim()) && (method.value === "oauth" || Boolean(token.value.trim())));

watch(open, (isOpen) => {
  if (!isOpen) return;
  server.value = props.preset?.server ?? props.servers[0]?.url ?? "";
  method.value = "oauth";
  another.value = Boolean(props.preset?.another) && !anotherBlocked.value;
  token.value = "";
  label.value = "";
  error.value = undefined;
}, { immediate: true });

async function submit(): Promise<void> {
  if (!canSubmit.value || pending.value) return;
  pending.value = true;
  error.value = undefined;
  try {
    const result = await requestConsoleMcp(props.base, "mcp-client.connect", {
      server: server.value.trim(),
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(method.value === "token" ? { token: token.value.trim() } : {}),
      ...(method.value === "oauth" && another.value && !anotherBlocked.value ? { prompt: "login" } : {}),
    });
    if (result.authorizationUrl) {
      // The authorization server sends the browser back to the Console's callback page, which finishes the sign-in.
      window.location.assign(result.authorizationUrl);
      return;
    }
    emit("connected", result.connection);
    open.value = false;
  }
  catch (cause) {
    error.value = cause;
  }
  // A sign-in keeps the button busy until the browser leaves the page.
  pending.value = false;
}
</script>

<template>
  <UModal v-model:open="open" title="Connect to an MCP server" description="The Console connects from the server, as you. Tokens stay on the server." :ui="{ content: 'sm:max-w-[520px]' }">
    <template #body>
      <form id="vitehub-mcp-connect" class="grid gap-5" @submit.prevent="submit">
        <UFormField label="Server" description="The Streamable HTTP endpoint, or a path on this app." name="server" required>
          <UInput
            v-model="server"
            class="w-full"
            autocomplete="off"
            placeholder="https://example.com/mcp or /mcp"
            spellcheck="false"
            :ui="{ base: 'font-mono text-base sm:text-sm' }"
          />
          <div v-if="servers.length" class="mt-2 flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-dimmed">This app:</span>
            <UButton
              v-for="candidate in servers"
              :key="candidate.url"
              color="neutral"
              size="xs"
              variant="soft"
              :aria-pressed="server === candidate.url"
              :label="`${candidate.label} · ${consoleMcpEndpoint(candidate.url)}`"
              @click="server = candidate.url"
            />
          </div>
        </UFormField>

        <UFormField label="Sign in with" name="method">
          <URadioGroup v-model="method" :items="methods" variant="card" orientation="horizontal" :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2', item: 'items-start' }" />
        </UFormField>

        <UCheckbox
          v-if="method === 'oauth'"
          v-model="another"
          :disabled="anotherBlocked"
          label="Sign in as someone else"
          :description="anotherBlocked
            ? 'This app’s sign-in is also the Console’s, so signing in as someone else here would sign the Console in as them. Use their token instead.'
            : 'The authorization server shows its sign-in even when this browser is signed in.'"
        />
        <UFormField v-else label="Bearer token" description="Sent in the Authorization header. The Console never shows it again." name="token" required>
          <UInput v-model="token" class="w-full" type="password" autocomplete="off" spellcheck="false" :ui="{ base: 'font-mono text-base sm:text-sm' }" />
        </UFormField>

        <UFormField label="Name" description="Optional. A sign-in names the connection after its account." name="label">
          <UInput v-model="label" class="w-full" maxlength="80" :placeholder="method === 'token' ? 'Lucía (API key)' : undefined" :ui="{ base: 'text-base sm:text-sm' }" />
        </UFormField>

        <div aria-live="polite">
          <ConsoleState v-if="error" compact :error="error" title="Couldn't connect" />
        </div>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" label="Cancel" variant="ghost" @click="open = false" />
        <UButton form="vitehub-mcp-connect" type="submit" :label="method === 'oauth' ? 'Continue' : 'Connect'" :loading="pending" :disabled="!canSubmit" />
      </div>
    </template>
  </UModal>
</template>
