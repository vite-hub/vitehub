<script setup lang="ts">
import type {
  AuthConsoleAction,
  AuthConsoleDescription,
  AuthConsoleField,
  AuthConsoleUserDetail,
  AuthConsoleValue,
} from "@vite-hub/auth/console";
import { computed, ref, shallowRef, watch } from "vue";
import { authDate, authFieldValue, changeAuthConsole, readAuthConsole } from "../client/auth-management";
import { consoleDurationWords } from "../client/format";
import ConsoleAuthAction from "./console-auth-action.vue";
import ConsoleAuthUserEvents from "./console-auth-user-events.vue";
import type { ConsoleProperty } from "./console-facts";
import ConsolePropertyList from "./console-property-list.vue";
import ConsoleSection from "./console-section.vue";
import ConsoleState from "./console-state.vue";
import ConsoleValue from "./console-value.vue";
const props = defineProps<{ id?: string; description: AuthConsoleDescription }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const detail = shallowRef<AuthConsoleUserDetail>();
const error = shallowRef<unknown>();
const loading = ref(false);
const paging = ref(false);
const revision = ref(0);
const action = ref<AuthConsoleAction>();
const actionId = ref<string>();
const field = shallowRef<AuthConsoleField>();
const fieldValue = ref<AuthConsoleValue>();
const open = computed({
  get: () => Boolean(props.id),
  set: (value: boolean) => {
    if (!value) emit("close");
  },
});
let sequence = 0;
async function refresh() {
  const current = ++sequence;
  if (!props.id) {
    detail.value = undefined;
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const value = await readAuthConsole("user", { id: props.id });
    if (current === sequence) {
      detail.value = value;
      revision.value++;
    }
  } catch (cause) {
    if (current === sequence) error.value = cause;
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(
  () => props.id,
  () => {
    detail.value = undefined;
    action.value = undefined;
    void refresh();
  },
  { immediate: true },
);
function act(name: AuthConsoleAction, id?: string, selectedField?: AuthConsoleField) {
  actionId.value = id;
  field.value = selectedField;
  fieldValue.value = selectedField
    ? detail.value?.user.fields[selectedField.key]
    : name === "setRole"
      ? detail.value?.user.role
      : undefined;
  action.value = name;
}
async function changed(name: AuthConsoleAction) {
  emit("changed");
  if (name === "remove") emit("close");
  else await refresh();
}
async function page(kind: "sessions" | "agents", direction: number) {
  if (!detail.value || !props.id || paging.value) return;
  const currentSequence = sequence;
  paging.value = true;
  try {
    const current = detail.value[kind];
    const next = await readAuthConsole(kind, {
      query: { userId: props.id, offset: current.offset + direction * current.limit },
    });
    if (currentSequence !== sequence || !detail.value) return;
    if (kind === "sessions")
      detail.value = { ...detail.value, sessions: next as AuthConsoleUserDetail["sessions"] };
    else detail.value = { ...detail.value, agents: next as AuthConsoleUserDetail["agents"] };
  } catch (cause) {
    if (currentSequence === sequence) error.value = cause;
  } finally {
    paging.value = false;
  }
}
/** The profile rows. Role, status, and editable fields show their own controls in the list's value slot. */
const profile = computed<Array<ConsoleProperty & { field?: AuthConsoleField; kind: "field" | "role" | "status" | "text" }>>(() => {
  const user = detail.value?.user;
  if (!user) return [];
  return [
    { kind: "text", label: "User ID", mono: true, value: user.id },
    { kind: "text", label: "Created", value: authDate(user.createdAt) },
    { kind: "text", label: "Last active", value: authDate(user.lastActive) },
    { kind: "role", label: "Role", value: user.role },
    { kind: "status", label: "Status", value: user.banned ? "Banned" : "Active" },
    ...props.description.fields.map((item) => ({ field: item, kind: "field" as const, label: item.label, value: authFieldValue(user.fields[item.key]) })),
  ];
});
const actions = computed(() => [
  {
    id: detail.value?.user.banned ? ("unban" as const) : ("ban" as const),
    label: detail.value?.user.banned ? "Unban user" : "Ban user",
  },
  { id: "revokeSessions" as const, label: "Revoke all sessions" },
  { id: "remove" as const, label: "Remove user" },
]);
// Shown only when the Console enables impersonation. The first reason that blocks it replaces the explanation.
const impersonation = computed(() => {
  const settings = props.description.impersonation;
  if (!settings || !detail.value) return undefined;
  const blocked = [
    props.description.actions.impersonate,
    detail.value.impersonation ?? { enabled: false, reason: "Reload to check this user." },
  ].find((capability) => !capability.enabled);
  return {
    enabled: !blocked,
    note:
      blocked?.reason ??
      `A new tab opens the app as this user, in this browser's app session. It lasts ${consoleDurationWords(settings.duration)}. Activity records the start and the stop.`,
  };
});
const stopping = ref(false);
const stopError = ref("");
/** Opens a one-time link that ends the impersonation of this browser and restores your own app session. */
async function stopImpersonating() {
  stopping.value = true;
  stopError.value = "";
  try {
    await changeAuthConsole({ action: "stopImpersonating" });
  } catch (cause) {
    stopError.value = cause instanceof Error ? cause.message : "Could not stop impersonating.";
  } finally {
    stopping.value = false;
  }
}
</script>
<template>
  <USlideover
    v-model:open="open"
    :title="detail?.user.name || 'User details'"
    :description="detail?.user.email || 'Profile and access'"
    :ui="{ content: 'max-w-xl', body: 'p-0' }"
  >
    <template #body>
      <ConsoleState v-if="error" :error="error" title="Could not load user" :retry="refresh" />
      <p v-else-if="loading && !detail" role="status" class="p-4 text-sm text-muted">
        Loading user…
      </p>
      <div v-else-if="detail" class="divide-y divide-default text-sm">
        <ConsoleSection v-if="impersonation" :level="3" title="Open the app as this user" class="p-4">
          <template #actions>
            <UButton
              icon="i-lucide-venetian-mask"
              variant="outline"
              class="shrink-0"
              aria-describedby="auth-impersonate-note"
              :disabled="!impersonation.enabled"
              @click="act('impersonate')"
              >Impersonate</UButton
            ><UButton
              variant="ghost"
              class="shrink-0"
              :loading="stopping"
              @click="stopImpersonating"
              >Stop impersonating</UButton
            >
          </template>
          <p id="auth-impersonate-note" class="text-xs text-pretty text-muted">{{ impersonation.note }}</p>
          <p v-if="stopError" role="alert" class="text-xs text-error">{{ stopError }}</p>
        </ConsoleSection>
        <ConsolePropertyList title="Profile" :items="profile" class="p-4">
          <template #value="{ item }">
            <template v-if="item.kind === 'role'">
              <div class="flex items-center justify-between gap-2">
                <span>{{ item.value }}</span
                ><UButton
                  size="xs"
                  variant="ghost"
                  :disabled="!description.actions.setRole.enabled"
                  @click="act('setRole')"
                  >Change role</UButton
                >
              </div>
              <p v-if="description.actions.setRole.reason" class="mt-1 text-xs text-muted">{{ description.actions.setRole.reason }}</p>
            </template>
            <template v-else-if="item.kind === 'status'">
              <!-- The same words and colors as the Status column of the user list. -->
              <span :class="detail.user.banned ? 'text-error' : ''">{{ item.value }}</span>
              <p v-if="detail.user.banReason" class="mt-1 text-xs text-muted">{{ detail.user.banReason }}</p>
              <p v-if="detail.user.banExpires" class="text-xs text-muted">Until {{ authDate(detail.user.banExpires) }}</p>
            </template>
            <template v-else-if="item.field">
              <div class="flex items-center justify-between gap-2">
                <span class="min-w-0 break-words">{{ item.value }}</span
                ><UButton
                  v-if="!item.field.computed"
                  size="xs"
                  variant="ghost"
                  :disabled="!item.field.edit.enabled"
                  :aria-label="`Edit ${item.label}`"
                  @click="act('editField', undefined, item.field)"
                  >Edit</UButton
                >
              </div>
              <p v-if="!item.field.edit.enabled" class="mt-1 text-xs text-muted">{{ item.field.edit.reason }}</p>
            </template>
            <ConsoleValue v-else :value="item.value" />
          </template>
        </ConsolePropertyList>
        <ConsoleSection :level="3" title="Sessions" :count="detail.sessions.total" class="p-4">
          <UEmpty v-if="!detail.sessions.total" variant="naked" size="sm" icon="i-lucide-monitor-smartphone" title="No active sessions" description="A session shows here when the user signs in." />
          <ul class="space-y-3">
            <li
              v-for="session in detail.sessions.items"
              :key="session.id"
              class="flex items-start justify-between gap-3"
            >
              <div>
                <p>{{ session.device }}</p>
                <p class="text-xs text-muted">Expires {{ authDate(session.expiresAt) }}</p>
              </div>
              <UButton
                size="xs"
                variant="ghost"
                :disabled="!description.actions.revokeSession.enabled"
                :title="description.actions.revokeSession.reason"
                @click="act('revokeSession', session.id)"
                >Revoke</UButton
              >
            </li>
          </ul>
          <p v-if="description.actions.revokeSession.reason" class="text-xs text-muted">
            {{ description.actions.revokeSession.reason }}
          </p>
          <div v-if="detail.sessions.total > detail.sessions.limit" class="flex justify-between">
            <UButton
              size="xs"
              variant="ghost"
              :disabled="paging || detail.sessions.offset === 0"
              @click="page('sessions', -1)"
              >Previous</UButton
            ><UButton
              size="xs"
              variant="ghost"
              :disabled="
                paging || detail.sessions.offset + detail.sessions.limit >= detail.sessions.total
              "
              @click="page('sessions', 1)"
              >Next</UButton
            >
          </div>
        </ConsoleSection>
        <ConsoleSection :level="3" title="Linked accounts" :count="detail.accountsTotal" class="p-4">
          <p v-if="detail.accountsTotal > detail.accounts.length" class="text-xs text-muted">
            Showing the first {{ detail.accounts.length }} of {{ detail.accountsTotal }} linked
            accounts.
          </p>
          <UEmpty v-if="!detail.accounts.length" variant="naked" size="sm" icon="i-lucide-link" title="No linked accounts" description="An account shows here when the user signs in with a provider." />
          <ul class="space-y-2">
            <li
              v-for="account in detail.accounts"
              :key="account.id"
              class="flex justify-between gap-3"
            >
              <span>{{ account.provider }}</span
              ><span class="truncate text-muted">{{ account.accountId }}</span>
            </li>
          </ul>
        </ConsoleSection>
        <ConsoleSection v-if="description.pages.includes('agents')" :level="3" title="Approved clients" :count="detail.agents.total" class="p-4">
          <UEmpty v-if="!detail.agents.total" variant="naked" size="sm" icon="i-lucide-bot" title="No approved clients" description="A client shows here after the user approves its access." />
          <ul class="space-y-3">
            <li
              v-for="client in detail.agents.items"
              :key="client.id"
              class="flex items-start justify-between gap-3"
            >
              <div>
                <p>{{ client.name }}</p>
                <p class="break-words text-xs text-muted">{{ client.scopes.join(", ") }}</p>
              </div>
              <UButton
                size="xs"
                variant="ghost"
                :disabled="!description.actions.revokeConsent.enabled"
                @click="act('revokeConsent', client.id)"
                >Revoke</UButton
              >
            </li>
          </ul>
          <p v-if="description.actions.revokeConsent.reason" class="text-xs text-muted">
            {{ description.actions.revokeConsent.reason }}
          </p>
          <div v-if="detail.agents.total > detail.agents.limit" class="flex justify-between">
            <UButton
              size="xs"
              variant="ghost"
              :disabled="paging || detail.agents.offset === 0"
              @click="page('agents', -1)"
              >Previous</UButton
            ><UButton
              size="xs"
              variant="ghost"
              :disabled="
                paging || detail.agents.offset + detail.agents.limit >= detail.agents.total
              "
              @click="page('agents', 1)"
              >Next</UButton
            >
          </div>
        </ConsoleSection>
        <ConsoleSection v-if="description.pages.includes('organizations')" :level="3" title="Organizations" :count="detail.organizationsTotal" class="p-4">
          <p
            v-if="detail.organizationsTotal > detail.organizations.length"
            class="text-xs text-muted"
          >
            Showing the first {{ detail.organizations.length }} of
            {{ detail.organizationsTotal }} memberships.
          </p>
          <UEmpty v-if="!detail.organizations.length" variant="naked" size="sm" icon="i-lucide-building-2" title="No organizations" description="A membership shows here when the user joins an organization." />
          <ul class="space-y-2">
            <li
              v-for="org in detail.organizations"
              :key="org.id"
              class="flex justify-between gap-3"
            >
              <span>{{ org.name }}</span
              ><span class="text-muted">{{ org.role }}</span>
            </li>
          </ul>
        </ConsoleSection>
        <ConsoleAuthUserEvents
          v-if="description.events.enabled"
          :user-id="detail.user.id"
          :revision="revision"
        />
        <ConsoleSection :level="3" title="Actions" class="p-4">
          <div v-for="item in actions" :key="item.id">
            <UButton
              :color="item.id === 'remove' ? 'error' : 'neutral'"
              variant="ghost"
              :disabled="!description.actions[item.id].enabled"
              @click="act(item.id)"
              >{{ item.label }}</UButton
            >
            <p v-if="description.actions[item.id].reason" class="px-2 text-xs text-muted">
              {{ description.actions[item.id].reason }}
            </p>
          </div>
        </ConsoleSection>
      </div>
      <ConsoleAuthAction
        :action="action"
        :id="actionId"
        :user-id="id"
        :field="field"
        :value="fieldValue"
        :name="detail?.user.email"
        :duration="description.impersonation?.duration"
        @close="action = undefined"
        @changed="changed"
      />
    </template>
  </USlideover>
</template>
