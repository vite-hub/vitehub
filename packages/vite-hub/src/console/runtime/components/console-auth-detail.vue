<script setup lang="ts">
import type {
  AuthConsoleAction,
  AuthConsoleDescription,
  AuthConsoleField,
  AuthConsoleUserDetail,
  AuthConsoleValue,
} from "@vite-hub/auth/console";
import { computed, ref, shallowRef, watch } from "vue";
import { authDate, authDuration, authFieldValue, readAuthConsole } from "../client/auth-management";
import { consoleMountBase, consoleMountPath } from "../console-route";
import ConsoleAuthAction from "./console-auth-action.vue";
import ConsoleAuthUserEvents from "./console-auth-user-events.vue";
import ConsoleState from "./console-state.vue";
const props = defineProps<{ base: string; id?: string; description: AuthConsoleDescription }>();
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
    const value = await readAuthConsole(props.base, "user", { id: props.id });
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
  else if (name === "impersonate")
    window.location.assign(consoleMountPath(consoleMountBase(window.location.pathname), "/"));
  else await refresh();
}
async function page(kind: "sessions" | "agents", direction: number) {
  if (!detail.value || !props.id || paging.value) return;
  const currentSequence = sequence;
  paging.value = true;
  try {
    const current = detail.value[kind];
    const next = await readAuthConsole(props.base, kind, {
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
      `The session lasts ${authDuration(settings.duration)}. Activity records the start and the stop.`,
  };
});
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
        <section
          v-if="impersonation"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4"
          aria-labelledby="auth-impersonate"
        >
          <div class="min-w-48 flex-1 space-y-1">
            <h2 id="auth-impersonate" class="font-medium text-highlighted">
              Open the app as this user
            </h2>
            <p id="auth-impersonate-note" class="text-xs text-pretty text-muted">
              {{ impersonation.note }}
            </p>
          </div>
          <UButton
            icon="i-lucide-venetian-mask"
            color="neutral"
            variant="outline"
            size="sm"
            class="shrink-0"
            aria-describedby="auth-impersonate-note"
            :disabled="!impersonation.enabled"
            @click="act('impersonate')"
            >Impersonate</UButton
          >
        </section>
        <section class="space-y-3 p-4" aria-labelledby="auth-profile">
          <h2 id="auth-profile" class="font-medium text-highlighted">Profile</h2>
          <dl class="grid grid-cols-[8rem_1fr] items-start gap-x-3 gap-y-3">
            <dt class="text-muted">User ID</dt>
            <dd class="break-all font-mono text-xs">{{ detail.user.id }}</dd>
            <dt class="text-muted">Created</dt>
            <dd>{{ authDate(detail.user.createdAt) }}</dd>
            <dt class="text-muted">Last active</dt>
            <dd>{{ authDate(detail.user.lastActive) }}</dd>
            <dt class="text-muted">Role</dt>
            <dd>
              <div class="flex items-center justify-between gap-2">
                <span>{{ detail.user.role }}</span
                ><UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="!description.actions.setRole.enabled"
                  @click="act('setRole')"
                  >Change role</UButton
                >
              </div>
              <p v-if="description.actions.setRole.reason" class="mt-1 text-xs text-muted">
                {{ description.actions.setRole.reason }}
              </p>
            </dd>
            <dt class="text-muted">Status</dt>
            <dd>
              <!-- The same words and colors as the Status column of the user list. -->
              <span :class="detail.user.banned ? 'text-error' : ''">{{ detail.user.banned ? "Banned" : "Active" }}</span>
              <p v-if="detail.user.banReason" class="mt-1 text-xs text-muted">
                {{ detail.user.banReason }}
              </p>
              <p v-if="detail.user.banExpires" class="text-xs text-muted">
                Until {{ authDate(detail.user.banExpires) }}
              </p>
            </dd>
            <template v-for="item in description.fields" :key="item.key"
              ><dt class="text-muted">{{ item.label }}</dt>
              <dd>
                <div class="flex items-center justify-between gap-2">
                  <span class="min-w-0 break-words">{{
                    authFieldValue(detail.user.fields[item.key])
                  }}</span
                  ><UButton
                    v-if="!item.computed"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :disabled="!item.edit.enabled"
                    :aria-label="`Edit ${item.label}`"
                    @click="act('editField', undefined, item)"
                    >Edit</UButton
                  >
                </div>
                <p v-if="!item.edit.enabled" class="mt-1 text-xs text-muted">
                  {{ item.edit.reason }}
                </p>
              </dd></template
            >
          </dl>
        </section>
        <section class="space-y-3 p-4" aria-labelledby="auth-user-sessions">
          <h2 id="auth-user-sessions" class="font-medium text-highlighted">
            Sessions <span class="ml-1 font-normal text-dimmed tabular-nums">{{ detail.sessions.total }}</span>
          </h2>
          <p v-if="!detail.sessions.total" class="text-muted">No active sessions.</p>
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
                color="neutral"
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
        </section>
        <section class="space-y-3 p-4" aria-labelledby="auth-user-accounts">
          <h2 id="auth-user-accounts" class="font-medium text-highlighted">
            Linked accounts
            <span class="ml-1 font-normal text-dimmed tabular-nums">{{ detail.accountsTotal }}</span>
          </h2>
          <p v-if="detail.accountsTotal > detail.accounts.length" class="text-xs text-muted">
            Showing the first {{ detail.accounts.length }} of {{ detail.accountsTotal }} linked
            accounts.
          </p>
          <p v-if="!detail.accounts.length" class="text-muted">No linked accounts.</p>
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
        </section>
        <section
          v-if="description.pages.includes('agents')"
          class="space-y-3 p-4"
          aria-labelledby="auth-user-agents"
        >
          <h2 id="auth-user-agents" class="font-medium text-highlighted">
            Approved clients
            <span class="ml-1 font-normal text-dimmed tabular-nums">{{ detail.agents.total }}</span>
          </h2>
          <p v-if="!detail.agents.total" class="text-muted">No approved clients.</p>
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
                color="neutral"
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
        </section>
        <section
          v-if="description.pages.includes('organizations')"
          class="space-y-3 p-4"
          aria-labelledby="auth-user-organizations"
        >
          <h2 id="auth-user-organizations" class="font-medium text-highlighted">
            Organizations
            <span class="ml-1 font-normal text-dimmed tabular-nums">{{ detail.organizationsTotal }}</span>
          </h2>
          <p
            v-if="detail.organizationsTotal > detail.organizations.length"
            class="text-xs text-muted"
          >
            Showing the first {{ detail.organizations.length }} of
            {{ detail.organizationsTotal }} memberships.
          </p>
          <p v-if="!detail.organizations.length" class="text-muted">No organizations.</p>
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
        </section>
        <ConsoleAuthUserEvents
          v-if="description.events.enabled"
          :base="base"
          :user-id="detail.user.id"
          :revision="revision"
        />
        <section class="space-y-3 p-4" aria-labelledby="auth-user-actions">
          <h2 id="auth-user-actions" class="font-medium text-highlighted">Actions</h2>
          <div v-for="item in actions" :key="item.id">
            <UButton
              :color="item.id === 'remove' ? 'error' : 'neutral'"
              variant="ghost"
              size="sm"
              :disabled="!description.actions[item.id].enabled"
              @click="act(item.id)"
              >{{ item.label }}</UButton
            >
            <p v-if="description.actions[item.id].reason" class="px-2 text-xs text-muted">
              {{ description.actions[item.id].reason }}
            </p>
          </div>
        </section>
      </div>
      <ConsoleAuthAction
        :base="base"
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
