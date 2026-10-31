<script setup lang="ts">
import type {
  AuthConsoleAction,
  AuthConsoleAgent,
  AuthConsoleDescription,
  AuthConsoleList,
  AuthConsoleOrganization,
  AuthConsoleOrganizationDetail,
  AuthConsolePage,
  AuthConsoleOverview,
  AuthConsoleQuery,
  AuthConsoleSession,
  AuthConsoleUser,
} from "@vite-hub/auth/console";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  authDate,
  authFieldValue,
  changeAuthConsole,
  readAuthConsole,
} from "../client/auth-management";
import { consoleMountBase, consoleMountPath } from "../console-route";
import { rememberConsoleSection } from "../sections";
import ConsoleAuthAction from "./console-auth-action.vue";
import ConsoleAuthDetail from "./console-auth-detail.vue";
import ConsoleAuthOverview from "./console-auth-overview.vue";
import ConsoleAuthActivity from "./console-auth-activity.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleState from "./console-state.vue";
const props = defineProps<{ sectionsBase: string; managementBase: string }>();
const route = useRoute();
const router = useRouter();
const page = computed<AuthConsolePage>(() =>
  ["users", "sessions", "organizations", "agents", "activity"].includes(String(route.params.page))
    ? (route.params.page as AuthConsolePage)
    : "overview",
);
const description = shallowRef<AuthConsoleDescription>();
const overview = shallowRef<AuthConsoleOverview>();
const revision = ref(0);
const users = shallowRef<AuthConsoleUser[]>([]);
const sessions = shallowRef<AuthConsoleSession[]>([]);
const organizations = shallowRef<AuthConsoleOrganization[]>([]);
const agents = shallowRef<AuthConsoleAgent[]>([]);
const total = ref(0);
const offset = ref(0);
const limit = 25;
const search = ref("");
const filter = ref<NonNullable<AuthConsoleQuery["filter"]>>("all");
const selectedUser = computed({
  get: () => (typeof route.query.user === "string" ? route.query.user : undefined),
  set: (user: string | undefined) => {
    void router.replace({ query: { ...route.query, user } });
  },
});
const selectedOrg = shallowRef<AuthConsoleOrganizationDetail>();
const orgOffset = ref(0);
const loading = ref(false);
const error = shallowRef<unknown>();
const orgError = shallowRef<unknown>();
const action = ref<AuthConsoleAction>();
const actionId = ref<string>();
const labels: Record<AuthConsolePage, string> = {
  overview: "Overview",
  activity: "Activity",
  users: "Users",
  sessions: "Sessions",
  organizations: "Organizations",
  agents: "Agents",
};
const icons: Record<AuthConsolePage, string> = {
  overview: "i-lucide-chart-no-axes-combined",
  activity: "i-lucide-history",
  users: "i-lucide-users-round",
  sessions: "i-lucide-monitor",
  organizations: "i-lucide-building-2",
  agents: "i-lucide-bot",
};
// With Console Auth, the app session of this browser can be an impersonation session while the Console stays open.
const impersonating = computed(() => description.value?.impersonation?.active ?? undefined);
const appRoot = computed(() =>
  impersonating.value ? consoleMountPath(consoleMountBase(window.location.pathname), "/") : "/",
);
const stopping = ref(false);
const stopError = ref("");
async function stopImpersonating() {
  const target = impersonating.value?.user.id;
  stopping.value = true;
  stopError.value = "";
  try {
    await changeAuthConsole(props.managementBase, { action: "stopImpersonating" });
    if (target) selectedUser.value = target;
    await refresh();
  } catch (cause) {
    stopError.value = cause instanceof Error ? cause.message : "Could not stop impersonating.";
  } finally {
    stopping.value = false;
  }
}
let controller: AbortController | undefined;
let orgController: AbortController | undefined;
function closeOrganization() {
  orgController?.abort();
  selectedOrg.value = undefined;
  orgError.value = undefined;
}
let timer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = undefined;
  try {
    const config = await readAuthConsole(props.managementBase, "describe", {}, current.signal);
    if (current.signal.aborted) return;
    description.value = config;
    if (page.value === "overview") {
      const result = await readAuthConsole(props.managementBase, "overview", {}, current.signal);
      if (!current.signal.aborted) overview.value = result;
      return;
    }
    if (page.value === "activity") {
      revision.value++;
      return;
    }
    if (!config.storage.enabled) return;
    if (!config.pages.includes(page.value))
      throw new Error("This page needs a Better Auth plugin that the app has not enabled.");
    const query = { offset: offset.value, limit, search: search.value, filter: filter.value };
    let list: AuthConsoleList<unknown>;
    if (page.value === "users") {
      const result = await readAuthConsole(
        props.managementBase,
        "users",
        { query },
        current.signal,
      );
      users.value = result.items;
      list = result;
    } else if (page.value === "sessions") {
      const result = await readAuthConsole(
        props.managementBase,
        "sessions",
        { query },
        current.signal,
      );
      sessions.value = result.items;
      list = result;
    } else if (page.value === "organizations") {
      const result = await readAuthConsole(
        props.managementBase,
        "organizations",
        { query },
        current.signal,
      );
      organizations.value = result.items;
      list = result;
    } else {
      const result = await readAuthConsole(
        props.managementBase,
        "agents",
        { query },
        current.signal,
      );
      agents.value = result.items;
      list = result;
    }
    if (!current.signal.aborted) total.value = list.total;
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause;
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}
function navigate(target: AuthConsolePage) {
  void router.push({
    name: "vitehub-console-auth",
    params: { page: target === "overview" ? undefined : target },
  });
}
watch(page, () => {
  offset.value = 0;
  closeOrganization();
  void refresh();
});
watch([search, filter], () => {
  offset.value = 0;
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 200);
});
watch(offset, () => void refresh());
async function openOrganization(id: string, offset = 0) {
  orgController?.abort();
  const current = new AbortController();
  orgController = current;
  orgError.value = undefined;
  try {
    const result = await readAuthConsole(
      props.managementBase,
      "organization",
      { id, query: { offset, limit } },
      current.signal,
    );
    if (current.signal.aborted) return;
    selectedOrg.value = result;
    orgOffset.value = offset;
  } catch (cause) {
    if (!current.signal.aborted) orgError.value = cause;
  }
}
rememberConsoleSection("auth");
void refresh();
onBeforeUnmount(() => {
  controller?.abort();
  orgController?.abort();
  clearTimeout(timer);
});
</script>
<template>
  <ConsoleFrame active="auth" :sections-base="sectionsBase">
    <UDashboardPanel id="auth" :ui="{ body: 'min-h-0 overflow-hidden p-0 sm:p-0 gap-0 sm:gap-0' }">
      <template #header>
        <UDashboardNavbar title="Auth" :toggle="false"
          ><template #right
            ><UButton
              aria-label="Refresh Auth"
              color="neutral"
              icon="i-lucide-refresh-cw"
              size="xs"
              variant="ghost"
              :disabled="loading"
              @click="refresh" /></template
        ></UDashboardNavbar>
        <nav aria-label="Auth pages" class="overflow-x-auto border-b border-default">
          <div class="mx-auto flex w-full max-w-6xl gap-1 px-4 py-2 sm:px-6">
          <UButton
            v-for="item in description?.pages ?? ['overview', 'users', 'activity']"
            :key="item"
            :icon="icons[item as AuthConsolePage]"
            :color="page === item ? 'primary' : 'neutral'"
            :variant="page === item ? 'soft' : 'ghost'"
            :aria-current="page === item ? 'page' : undefined"
            size="sm"
            @click="navigate(item as AuthConsolePage)"
            >{{ labels[item as AuthConsolePage] }}</UButton
          >
          </div>
        </nav>
        <div v-if="impersonating" class="border-b border-warning/25 bg-warning/10">
          <div
            class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6"
          >
            <div class="flex min-w-0 flex-[1_1_16rem] items-start gap-2">
              <UIcon
                name="i-lucide-venetian-mask"
                class="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <div class="min-w-0 text-sm text-pretty">
                <p role="status" class="text-highlighted">
                  This browser uses the app as
                  <span class="font-medium">{{
                    impersonating.user.name || impersonating.user.email
                  }}</span>
                  until {{ authDate(impersonating.expiresAt) }}.
                </p>
                <p v-if="stopError" role="alert" class="text-error">{{ stopError }}</p>
              </div>
            </div>
            <div class="flex shrink-0 gap-2">
              <UButton :to="appRoot" external size="xs" color="neutral" variant="ghost"
                >Open app</UButton
              ><UButton
                size="xs"
                color="neutral"
                :loading="stopping"
                @click="stopImpersonating"
                >Stop impersonating</UButton
              >
            </div>
          </div>
        </div>
        <ConsolePageToolbar v-if="page === 'users'" width="6xl">
          <UInput
            v-model="search"
            aria-label="Search users by name or email"
            placeholder="Search name or email…"
            icon="i-lucide-search"
            size="sm"
            class="min-w-48 flex-1 sm:max-w-72"
          /><USelect
            v-model="filter"
            aria-label="Filter users"
            :items="[
              { label: 'All users', value: 'all' },
              { label: 'Admins', value: 'admins' },
              { label: 'Banned', value: 'banned' },
              ...(description?.pages.includes('agents')
                ? [{ label: 'With agents', value: 'agents' }]
                : []),
            ]"
            size="sm"
            class="w-36"
          />
        </ConsolePageToolbar>
      </template>
      <template #body>
        <main class="flex min-h-0 flex-1 flex-col" :aria-busy="loading">
          <ConsoleState v-if="error" :error="error" title="Could not load Auth" :retry="refresh" />
          <ConsoleAuthOverview
            v-else-if="page === 'overview' && overview && description"
            :data="overview"
            :description="description"
          />
          <ConsoleAuthActivity
            v-else-if="page === 'activity' && description"
            :base="managementBase"
            :enabled="description.events.enabled"
            :revision="revision"
          />
          <ConsoleState
            v-else-if="description && !description.storage.enabled && page !== 'overview'"
            icon="i-lucide-users-round"
            title="No stored Auth data"
            :description="description.storage.reason"
          />
          <p v-else-if="loading" role="status" class="p-4 text-sm text-muted">
            Loading {{ labels[page].toLowerCase() }}…
          </p>
          <div v-else class="min-h-0 flex-1 overflow-auto">
            <div class="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4 sm:p-6">
              <details v-if="description?.access.length && page === 'users'" class="group text-xs text-muted">
                <summary class="inline-flex cursor-pointer items-center gap-1 rounded-sm select-none hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                  <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                  Access rules
                </summary>
                <ul class="mt-2 list-inside list-disc space-y-1">
                  <li v-for="rule in description.access" :key="rule">{{ rule }}</li>
                </ul>
              </details>
              <div class="overflow-x-auto rounded-md border border-default">
              <table class="w-full text-left text-sm auth-table" :aria-label="labels[page]">
                <thead class="bg-elevated/30">
                  <tr v-if="page === 'users'">
                    <th>User</th>
                    <th>Role</th>
                    <th v-for="field in description?.fields" :key="field.key" :class="field.type === 'number' ? 'text-right' : ''">{{ field.label }}</th>
                    <th>Sign-in methods</th>
                    <th>Last active</th>
                    <th>Created</th>
                    <th>Status</th>
                  </tr>
                  <tr v-else-if="page === 'sessions'">
                    <th>User</th>
                    <th>Device</th>
                    <th>Created</th>
                    <th>Expires</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                  <tr v-else-if="page === 'organizations'">
                    <th>Organization</th>
                    <th>Slug</th>
                    <th>Created</th>
                  </tr>
                  <tr v-else>
                    <th>Client</th>
                    <th>User</th>
                    <th>Scopes</th>
                    <th>Last used</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody v-if="page === 'users'">
                  <tr v-for="user in users" :key="user.id" class="relative hover:bg-elevated/50 has-focus-visible:bg-elevated/50">
                    <td>
                      <!-- The button overlay makes the whole row open the user. Focus shows as the row fill. -->
                      <button
                        class="flex max-w-72 items-center gap-2 text-left outline-none after:absolute after:inset-0"
                        @click="selectedUser = user.id"
                      >
                        <UAvatar :src="user.image ?? undefined" :alt="user.name" size="sm" /><span
                          class="min-w-0"
                          ><span class="block truncate font-medium text-highlighted">{{
                            user.name
                          }}</span
                          ><span class="block truncate text-xs text-muted">{{
                            user.email
                          }}</span></span
                        >
                      </button>
                    </td>
                    <td>{{ user.role }}</td>
                    <!-- Numbers align on the right, so their digits line up down the column. -->
                    <td v-for="field in description?.fields" :key="field.key" class="tabular-nums" :class="field.type === 'number' ? 'text-right' : ''">
                      {{ authFieldValue(user.fields[field.key]) }}
                    </td>
                    <td>{{ user.providers.join(", ") || "None" }}</td>
                    <td class="whitespace-nowrap text-muted tabular-nums">{{ authDate(user.lastActive) }}</td>
                    <td class="whitespace-nowrap text-muted tabular-nums">{{ authDate(user.createdAt) }}</td>
                    <td :class="user.banned ? 'text-error' : 'text-muted'">
                      {{ user.banned ? "Banned" : "Active" }}
                    </td>
                  </tr>
                </tbody>
                <tbody v-else-if="page === 'sessions'">
                  <tr v-for="session in sessions" :key="session.id">
                    <td>
                      <button
                        class="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        @click="selectedUser = session.user.id"
                      >
                        <span class="block text-highlighted">{{ session.user.name }}</span
                        ><span class="text-xs text-muted">{{ session.user.email }}</span>
                      </button>
                    </td>
                    <td>{{ session.device }}</td>
                    <td class="whitespace-nowrap text-muted tabular-nums">{{ authDate(session.createdAt) }}</td>
                    <td class="whitespace-nowrap text-muted tabular-nums">{{ authDate(session.expiresAt) }}</td>
                    <td class="text-right">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        :disabled="!description?.actions.revokeSession.enabled"
                        :title="description?.actions.revokeSession.reason"
                        @click="
                          action = 'revokeSession';
                          actionId = session.id;
                        "
                        >Revoke</UButton
                      >
                    </td>
                  </tr>
                </tbody>
                <tbody v-else-if="page === 'organizations'">
                  <tr v-for="org in organizations" :key="org.id" class="relative hover:bg-elevated/50 has-focus-visible:bg-elevated/50">
                    <td>
                      <button
                        class="text-left font-medium text-highlighted outline-none after:absolute after:inset-0"
                        @click="openOrganization(org.id)"
                      >
                        {{ org.name }}
                      </button>
                    </td>
                    <td class="font-mono text-xs text-muted">{{ org.slug }}</td>
                    <td class="text-muted">{{ authDate(org.createdAt) }}</td>
                  </tr>
                </tbody>
                <tbody v-else>
                  <tr v-for="client in agents" :key="client.id">
                    <td>
                      <span class="block font-medium text-highlighted">{{ client.name }}</span
                      ><span class="text-xs text-muted">{{ client.clientId }}</span>
                    </td>
                    <td>
                      <button
                        class="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        @click="selectedUser = client.user.id"
                      >
                        <span class="block">{{ client.user.name }}</span
                        ><span class="text-xs text-muted">{{ client.user.email }}</span>
                      </button>
                    </td>
                    <td class="max-w-72 whitespace-normal break-words font-mono text-xs">
                      {{ client.scopes.join(" ") }}
                    </td>
                    <td class="text-muted">{{ authDate(client.lastUsed) }}</td>
                    <td class="text-right">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        :disabled="!description?.actions.revokeConsent.enabled"
                        @click="
                          action = 'revokeConsent';
                          actionId = client.id;
                        "
                        >Revoke</UButton
                      >
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="!total" class="border-t border-default p-8 text-center text-sm text-muted">
                {{
                  search || filter !== "all"
                    ? "No users match these filters."
                    : `No ${labels[page].toLowerCase()} yet.`
                }}
              </p>
              </div>
            <p
              v-if="page === 'agents' && description?.actions.revokeConsent.reason"
              class="text-xs text-muted"
            >
              {{ description.actions.revokeConsent.reason }}
            </p>
            <p
              v-if="page === 'sessions' && description?.actions.revokeSession.reason"
              class="text-xs text-muted"
            >
              {{ description.actions.revokeSession.reason }}
            </p>
            <footer
              class="flex items-center justify-between gap-3 text-xs text-muted"
            >
              <span class="tabular-nums"
                >{{ total ? offset + 1 : 0 }}–{{ Math.min(offset + limit, total) }} of {{ total }}
                {{ labels[page].toLowerCase() }}</span
              >
              <div class="flex gap-1">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="offset === 0"
                  @click="offset -= limit"
                  >Previous</UButton
                ><UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="offset + limit >= total"
                  @click="offset += limit"
                  >Next</UButton
                >
              </div>
            </footer>
            </div>
          </div>
        </main>
      </template>
    </UDashboardPanel>
    <ConsoleAuthDetail
      v-if="description"
      :base="managementBase"
      :id="selectedUser"
      :description="description"
      @close="selectedUser = undefined"
      @changed="refresh"
    />
    <ConsoleAuthAction
      :base="managementBase"
      :action="action"
      :id="actionId"
      @close="action = undefined"
      @changed="refresh"
    />
    <USlideover
      :open="Boolean(selectedOrg || orgError)"
      :title="selectedOrg?.name ?? 'Organization'"
      description="Members and pending invitations"
      @update:open="
        (value) => {
          if (!value) {
            closeOrganization();
          }
        }
      "
    >
      <template #body
        ><ConsoleState
          v-if="orgError"
          :error="orgError"
          title="Could not load organization"
        /><template v-if="selectedOrg"
          ><h2 class="mb-3 text-sm font-medium">
            Members <span class="text-muted tabular-nums">{{ selectedOrg.membersTotal }}</span>
          </h2>
          <ul class="space-y-3">
            <li
              v-for="member in selectedOrg.members"
              :key="member.id"
              class="flex justify-between gap-3 text-sm"
            >
              <div>
                <p>{{ member.user.name }}</p>
                <p class="text-xs text-muted">{{ member.user.email }}</p>
              </div>
              <span class="text-muted">{{ member.role }}</span>
            </li>
          </ul>
          <h2 class="mb-3 mt-6 text-sm font-medium">
            Pending invitations
            <span class="text-muted tabular-nums">{{ selectedOrg.invitationsTotal }}</span>
          </h2>
          <p v-if="!selectedOrg.invitationsTotal" class="text-sm text-muted">
            No pending invitations.
          </p>
          <ul class="space-y-3">
            <li v-for="invitation in selectedOrg.invitations" :key="invitation.id" class="text-sm">
              <p>
                {{ invitation.email }} <span class="text-muted">{{ invitation.role }}</span>
              </p>
              <p class="text-xs text-muted">Expires {{ authDate(invitation.expiresAt) }}</p>
            </li>
          </ul>
          <div
            v-if="Math.max(selectedOrg.membersTotal, selectedOrg.invitationsTotal) > limit"
            class="mt-4 flex justify-between"
          >
            <UButton
              size="xs"
              variant="ghost"
              :disabled="orgOffset === 0"
              @click="openOrganization(selectedOrg.id, orgOffset - limit)"
              >Previous</UButton
            ><UButton
              size="xs"
              variant="ghost"
              :disabled="
                orgOffset + limit >=
                Math.max(selectedOrg.membersTotal, selectedOrg.invitationsTotal)
              "
              @click="openOrganization(selectedOrg.id, orgOffset + limit)"
              >Next</UButton
            >
          </div></template
        ></template
      >
    </USlideover>
  </ConsoleFrame>
</template>
<style scoped>
.auth-table th {
  height: 2.25rem;
  padding: 0 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.auth-table td {
  padding: 0.625rem 0.75rem;
  border-top: 1px solid var(--ui-border);
}
</style>
