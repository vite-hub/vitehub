<script setup lang="ts">
import type { ConnectionInspection } from "@vite-hub/connections";
import { onMounted, ref, watch } from "vue";

import {
  canSendConnectionKey,
  connectionConnectURL,
  connectionCredentialLabel,
  connectionResultSchema,
  connectionStatusColor,
  connectionStatusLabel,
  requestConnectionsManagement,
} from "../client/connections-management";
import ConsoleConnectionsActivity from "./console-connections-activity.vue";
import ConsoleConnectionsApprovals from "./console-connections-approvals.vue";
import ConsoleState from "./console-state.vue";

const props = defineProps<{
  connection: ConnectionInspection;
  endpoint: string;
  initialTab?: "activity" | "approvals" | "details";
  /** Open the API key form when the panel opens. */
  keyForm?: boolean;
  /** The Console page that the provider flow returns to. */
  returnTo?: string;
}>();
const emit = defineEmits<{ changed: [] }>();
const current = ref<ConnectionInspection>(props.connection);
watch(
  () => props.connection,
  (connection) => {
    current.value = connection;
  },
);
const tab = ref(props.initialTab ?? "details");
const busy = ref(false);
const error = ref<unknown>();
const keyBlocked = ref(false);
const notice = ref("");
const revoking = ref(false);
const confirmation = ref("");
const settingKey = ref(false);
const key = ref("");

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
  keyBlocked.value = !canSendConnectionKey(window.location);
  if (keyBlocked.value) return;
  settingKey.value = !settingKey.value;
}
function setKey() {
  const value = key.value.trim();
  if (!value) return;
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
    <div class="flex gap-2" aria-label="Connection views">
      <UButton
        v-for="item in [
          { value: 'details', label: 'Details' },
          { value: 'activity', label: 'Activity' },
          { value: 'approvals', label: 'Approvals' },
        ]"
        :key="item.value"
        :label="item.label"
        color="neutral"
        :variant="tab === item.value ? 'soft' : 'ghost'"
        :aria-pressed="tab === item.value"
        @click="tab = item.value"
      />
    </div>
    <template v-if="tab === 'details'">
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-4 text-sm">
        <dt class="text-muted">Status</dt>
        <dd>
          <UBadge
            :color="connectionStatusColor(current.status)"
            :label="connectionStatusLabel(current.status)"
            size="sm"
            variant="subtle"
          />
        </dd>
        <dt class="text-muted">Type</dt>
        <dd>{{ connectionCredentialLabel(current.credential) }}</dd>
        <dt class="text-muted">Provider</dt>
        <dd class="break-words text-highlighted">{{ current.provider }}</dd>
        <template v-if="current.account">
          <dt class="text-muted">Account</dt>
          <dd class="break-all">{{ current.account.email ?? current.account.id }}</dd>
        </template>
        <template v-if="current.connectedAt">
          <dt class="text-muted">Connected</dt>
          <dd>
            <time :datetime="current.connectedAt" class="tabular-nums">{{
              new Date(current.connectedAt).toLocaleString()
            }}</time>
          </dd>
        </template>
        <template v-if="current.refreshedAt">
          <dt class="text-muted">Refreshed</dt>
          <dd>
            <time :datetime="current.refreshedAt" class="tabular-nums">{{
              new Date(current.refreshedAt).toLocaleString()
            }}</time>
          </dd>
        </template>
        <template v-if="current.credential === 'oauth2'">
          <dt class="text-muted">Granted scopes</dt>
          <dd class="break-all font-mono text-xs">
            {{ current.scopes.granted.join(" ") || "None" }}
          </dd>
          <dt class="text-muted">Missing scopes</dt>
          <dd
            :class="[
              'break-all font-mono text-xs',
              current.scopes.missing.length ? 'text-error' : undefined,
            ]"
          >
            {{ current.scopes.missing.join(" ") || "None" }}
          </dd>
        </template>
      </dl>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="current.credential === 'api-key'"
          :label="current.status === 'connected' ? 'Replace key' : 'Set key'"
          color="neutral"
          variant="outline"
          :disabled="busy"
          :aria-expanded="settingKey"
          @click="openKeyForm"
        />
        <UButton
          v-else
          :label="
            current.status === 'disconnected' || current.status === 'revoked'
              ? 'Connect'
              : 'Reconnect'
          "
          :to="connectionConnectURL(endpoint, current.name, returnTo)"
          external
          color="neutral"
          variant="outline"
          trailing-icon="i-ph-arrow-up-right-light"
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
        <UButton label="Reload" color="neutral" variant="ghost" :loading="busy" @click="reload" />
      </div>
      <ConsoleState v-if="error" compact :error="error" title="Could not complete the request" />
      <p v-if="keyBlocked" role="alert" class="text-sm text-error">Open the Console over HTTPS to set an API key.</p>
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
      <section v-if="current.actions.length" class="space-y-2">
        <h3 class="text-sm text-muted">Allowed actions</h3>
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
      </section>
    </template>
    <ConsoleConnectionsActivity
      v-else-if="tab === 'activity'"
      :endpoint="endpoint"
      :name="current.name"
    />
    <ConsoleConnectionsApprovals
      v-else-if="tab === 'approvals'"
      :endpoint="endpoint"
      :name="current.name"
      @changed="emit('changed')"
    />
  </div>
</template>
