<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import type { ConnectionInspection } from "@vite-hub/connections";
import { computed, onMounted, ref, watch } from "vue";

import {
  canSendConnectionKeyTo,
  connectionActivityLabel,
  connectionActivitySchema,
  connectionKeyTransportMessage,
  connectionConnectURL,
  connectionCredentialLabel,
  connectionResultSchema,
  connectionStatusTone,
  connectionStatusLabel,
  requestConnectionsManagement,
} from "../client/connections-management";
import ConsoleCredentialActivity from "./console-credential-activity.vue";
import ConsoleConnectionsApprovals from "./console-connections-approvals.vue";
import { consoleDateTime } from "../client/format";
import { isRemoteProject } from "../client/project";
import ConsoleState from "./console-state.vue";
import type { ConsoleProperty } from "./console-facts";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleSection from "./console-section.vue";

const props = defineProps<{
  connection: ConnectionInspection;
  endpoint: string;
  /** Open the API key form when the panel opens. */
  keyForm?: boolean;
  /** The Console page that the provider flow returns to. */
  returnTo?: string;
}>();

// The connect flow needs the app session, so a Console on another origin sends it to the app's own Console.
const remote = isRemoteProject();
const emit = defineEmits<{ changed: [] }>();
const current = ref<ConnectionInspection>(props.connection);
watch(
  () => props.connection,
  (connection) => {
    current.value = connection;
  },
);
/** The open tab. The Connections page keeps it in the URL. */
const tab = defineModel<"activity" | "approvals" | "details">("tab", { default: "details" });
const busy = ref(false);
const error = ref<unknown>();
const keyBlocked = ref(false);
const notice = ref("");
const revoking = ref(false);
const confirmation = ref("");
const settingKey = ref(false);
const key = ref("");

/** The facts of the Connection. Times are absolute, and each scope takes its own line. */
const properties = computed<Array<ConsoleProperty & { datetime?: string }>>(() => {
  const connection = current.value;
  const scopes = (list: string[]) => (list.length ? { mono: true, value: list.join("\n") } : { value: "None" });
  return [
    { label: "Status", value: connectionStatusLabel(connection.status) },
    { label: "Type", value: connectionCredentialLabel(connection.credential) },
    { label: "Provider", value: connection.provider },
    ...(connection.account ? [{ label: "Account", value: connection.account.email ?? connection.account.id }] : []),
    ...(connection.connectedAt ? [{ datetime: connection.connectedAt, label: "Connected", value: consoleDateTime(connection.connectedAt) }] : []),
    ...(connection.refreshedAt ? [{ datetime: connection.refreshedAt, label: "Refreshed", value: consoleDateTime(connection.refreshedAt) }] : []),
    ...(connection.chatgpt
      ? [
          { label: "Plan usage", value: connection.chatgpt.plan === "enabled" ? "Enabled" : "Not enabled" },
          { label: "Host ID", mono: true, value: connection.chatgpt.hostId },
        ]
      : []),
    ...(connection.expiresAt ? [{ datetime: connection.expiresAt, label: "Token expires", value: consoleDateTime(connection.expiresAt) }] : []),
    ...(connection.credential === "api-key"
      ? []
      : [
          { label: "Granted scopes", ...scopes(connection.scopes.granted) },
          { label: "Missing scopes", ...scopes(connection.scopes.missing) },
        ]),
  ];
});

async function loadActivity(before?: string) {
  const input = { name: current.value.name, ...(before ? { before } : {}) };
  return (await requestConnectionsManagement(props.endpoint, "activity", connectionActivitySchema, input)).activity;
}

async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = undefined;
  keyBlocked.value = false;
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause;
  } finally {
    busy.value = false;
  }
}
async function inspect() {
  const result = await requestConnectionsManagement(props.endpoint, "inspect", connectionResultSchema, {
    name: props.connection.name,
  });
  current.value = result.connection;
}
function reload() {
  return run(async () => {
    await inspect();
    emit("changed");
  });
}
function openKeyForm() {
  error.value = undefined;
  keyBlocked.value = !canSendConnectionKeyTo(props.endpoint, window.location.href);
  if (keyBlocked.value) return;
  settingKey.value = !settingKey.value;
}
function setKey() {
  const value = key.value.trim();
  if (!value) return;
  // The project can change while the form is open, so check the destination again before the key leaves.
  if (!canSendConnectionKeyTo(props.endpoint, window.location.href)) {
    keyBlocked.value = true;
    settingKey.value = false;
    return;
  }
  return run(async () => {
    const result = await requestConnectionsManagement(props.endpoint, "set-key", connectionResultSchema, {
      key: value,
      name: props.connection.name,
    }, { redirect: "error" });
    current.value = result.connection;
    settingKey.value = false;
    key.value = "";
    notice.value = "Key stored. Calls use the new key now.";
    emit("changed");
  });
}
function revoke() {
  if (confirmation.value !== props.connection.name) return;
  return run(async () => {
    const result = await requestConnectionsManagement(props.endpoint, "revoke", connectionResultSchema, {
      name: props.connection.name,
    });
    current.value = result.connection;
    revoking.value = false;
    confirmation.value = "";
    notice.value = "Revoked. Calls through this Connection stop until you connect it again.";
    emit("changed");
  });
}
onMounted(async () => {
  await run(inspect);
  // The row action "Set key" opens the panel with the key field ready.
  if (props.keyForm && !error.value && current.value.credential === "api-key") openKeyForm();
});
</script>

<template>
  <div class="space-y-5">
    <UTabs
      v-model="tab"
      :items="[
        { value: 'details', label: 'Details' },
        { value: 'activity', label: 'Activity' },
        { value: 'approvals', label: 'Approvals' },
      ]"
      :content="false"
      aria-label="Connection views"
    />
    <template v-if="tab === 'details'">
      <ConsolePropertyList :items="properties">
        <template #value="{ item }">
          <Status v-if="item.label === 'Status'" :label="connectionStatusLabel(current.status)" :tone="connectionStatusTone(current.status)" />
          <span v-else-if="item.label === 'Missing scopes' && current.scopes.missing.length" class="text-error">{{ item.value }}</span>
          <time v-else-if="item.datetime" :datetime="item.datetime" class="tabular-nums">{{ item.value }}</time>
          <template v-else>{{ item.value }}</template>
        </template>
      </ConsolePropertyList>
      <p v-if="current.credential === 'chatgpt'" class="text-sm text-muted">
        Sign in from the app directory with
        <code class="break-all">vitehub connections connect {{ current.name }}</code>, then reload.
        For a remote host, sign in locally and import the grant over SSH.
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="current.credential === 'api-key'"
          :label="current.status === 'connected' ? 'Replace key' : 'Set key'"
          variant="outline"
          :disabled="busy"
          :aria-expanded="settingKey"
          @click="openKeyForm"
        />
        <UButton
          v-else-if="current.credential !== 'chatgpt'"
          :label="
            remote
              ? 'Connect in the app'
              : current.status === 'disconnected' || current.status === 'revoked'
                ? 'Connect'
                : 'Reconnect'
          "
          :to="connectionConnectURL(endpoint, current.name, returnTo)"
          external
          variant="outline"
          trailing-icon="i-lucide-arrow-up-right"
          :disabled="busy"
        />
        <UButton
          v-if="current.status === 'connected' || current.status === 'reauth_required'"
          label="Revoke"
          color="error"
          variant="ghost"
          :disabled="busy"
          @click="revoking = !revoking"
        />
        <UButton label="Reload" variant="ghost" :loading="busy" @click="reload" />
      </div>
      <ConsoleState v-if="error" compact :error="error" title="Could not complete the request" />
      <p v-if="keyBlocked" role="alert" class="text-sm text-error">{{ connectionKeyTransportMessage }}</p>
      <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
      <form v-if="settingKey" class="space-y-3" @submit.prevent="setKey">
        <UFormField
          label="API key"
          name="key"
          description="ViteHub stores the key sealed. The Console and Agents never read it again."
        >
          <UInput
            v-model="key"
            type="password"
            autocomplete="off"
            autofocus
            spellcheck="false"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <UButton type="submit" label="Store key" :loading="busy" :disabled="!key.trim()" />
      </form>
      <form v-if="revoking" class="space-y-3" @submit.prevent="revoke">
        <UFormField
          :label="`Type ${current.name} to revoke this Connection`"
          name="confirmation"
          :description="
            current.credential === 'api-key'
              ? 'The stored key is deleted. Revoke the key at the provider too.'
              : 'The stored token is deleted. Agents and server code lose access until you connect again.'
          "
        >
          <UInput v-model="confirmation" autocomplete="off" class="w-full" :disabled="busy" />
        </UFormField>
        <UButton
          type="submit"
          label="Revoke Connection"
          color="error"
          :loading="busy"
          :disabled="confirmation !== current.name"
        />
      </form>
      <ConsoleSection v-if="current.actions.length" :level="3" title="Allowed actions" :count="current.actions.length">
        <ul role="list" class="divide-y divide-default">
          <li
            v-for="action in current.actions"
            :key="action.id"
            class="flex flex-wrap justify-between gap-2 py-2 text-xs"
          >
            <span class="break-all font-mono text-highlighted">{{ action.id }}</span
            ><span :class="action.highRisk ? 'text-error' : 'text-muted'">{{
              action.highRisk ? "High risk" : action.write ? "Write" : "Read"
            }}</span>
          </li>
        </ul>
      </ConsoleSection>
    </template>
    <ConsoleCredentialActivity
      v-else-if="tab === 'activity'"
      :key="current.name"
      description="Persisted operations. Call inputs are not recorded."
      empty-title="No activity yet"
      empty-description="Calls, writes, and account changes show here."
      :label="connectionActivityLabel"
      :load="loadActivity"
    />
    <ConsoleConnectionsApprovals
      v-else-if="tab === 'approvals'"
      :endpoint="endpoint"
      :name="current.name"
      @changed="emit('changed')"
    />
  </div>
</template>
