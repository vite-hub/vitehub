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
import { queryChoice, queryInteger, querySelection, queryText, useConsoleQuery } from "../client/route-query";
import { projectAppUrl } from "../client/project";
import { rememberConsoleSection } from "../sections";
import ConsoleAuthAction from "./console-auth-action.vue";
import ConsoleAuthDetail from "./console-auth-detail.vue";
import ConsoleAuthOverview from "./console-auth-overview.vue";
import ConsoleAuthActivity from "./console-auth-activity.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";
import ConsoleSection from "./console-section.vue";
const props = defineProps<{ sectionsBase: string }>();
// The rail's Search button and Cmd+K open the search of the page. Its API routes sit next to the sections route.
const apiBase = props.sectionsBase.replace(/\/sections$/, "");
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
const limit = 25;
const filters: ReadonlyArray<NonNullable<AuthConsoleQuery["filter"]>> = ["all", "admins", "banned", "agents"];
// The search, filter, page, open user, and open organization live in the URL, so a reload or a shared link opens the same view.
const { filter, offset, org: selectedOrgId, q: search, user: selectedUser } = useConsoleQuery({
  filter: queryChoice(filters, "all"),
  offset: queryInteger(0, { history: "push" }),
  org: querySelection(),
  q: queryText(),
  user: querySelection(),
});
const selectedOrg = shallowRef<AuthConsoleOrganizationDetail>();
const orgName = computed(
  () => selectedOrg.value?.name ?? organizations.value.find((org) => org.id === selectedOrgId.value)?.name,
);
const orgOffset = ref(0);
const orgRequestedOffset = ref(0);
const orgLoading = ref(false);
const loading = ref(false);
const error = shallowRef<unknown>();
const orgError = shallowRef<unknown>();
const action = ref<AuthConsoleAction>();
const actionId = ref<string>();
/** The email of the user that a Sessions or Agents row action changes, for the confirmation. */
const actionName = ref<string>();
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
const appRoot = computed(() => (impersonating.value ? projectAppUrl("/") : "/"));
const stopping = ref(false);
const stopError = ref("");
async function stopImpersonating() {
  const target = impersonating.value?.user.id;
  stopping.value = true;
  stopError.value = "";
  try {
    await changeAuthConsole({ action: "stopImpersonating" });
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
  selectedOrgId.value = undefined;
  orgLoading.value = false;
}
let timer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = undefined;
  try {
    const config = await readAuthConsole("describe", {}, current.signal);
    if (current.signal.aborted) return;
    description.value = config;
    if (page.value === "overview") {
      const result = await readAuthConsole("overview", {}, current.signal);
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
    const query = { offset: offset.value, limit, search: search.value.trim(), filter: filter.value };
    let list: AuthConsoleList<unknown>;
    if (page.value === "users") {
      const result = await readAuthConsole(
        "users",
        { query },
        current.signal,
      );
      users.value = result.items;
      list = result;
    } else if (page.value === "sessions") {
      const result = await readAuthConsole(
        "sessions",
        { query },
        current.signal,
      );
      sessions.value = result.items;
      list = result;
    } else if (page.value === "organizations") {
      const result = await readAuthConsole(
        "organizations",
        { query },
        current.signal,
      );
      organizations.value = result.items;
      list = result;
    } else {
      const result = await readAuthConsole(
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
const pageItems = computed(() =>
  (description.value?.pages ?? (["overview", "users", "activity"] satisfies AuthConsolePage[])).map((item) => ({ label: labels[item], value: item, icon: icons[item] })),
);
function choosePage(value: string | number) {
  const target = pageItems.value.find((item) => item.value === value);
  if (target) navigate(target.value);
}
function navigate(target: AuthConsolePage) {
  void router.push({
    name: "vitehub-console-auth",
    params: { page: target === "overview" ? undefined : target },
  });
}
watch(page, () => {
  void refresh();
});
watch([search, filter], () => {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 200);
});
watch(offset, () => void refresh());
// The destination URL owns the open organization, including history across Auth pages.
watch(selectedOrgId, (id) => {
  if (!id) closeOrganization();
  else if (selectedOrg.value?.id !== id) void openOrganization(id);
}, { immediate: true });
async function openOrganization(id: string, offset = 0) {
  orgController?.abort();
  const current = new AbortController();
  orgController = current;
  orgRequestedOffset.value = offset;
  if (selectedOrg.value?.id !== id) selectedOrg.value = undefined;
  orgError.value = undefined;
  orgLoading.value = true;
  try {
    const result = await readAuthConsole(
      "organization",
      { id, query: { offset, limit } },
      current.signal,
    );
    if (current.signal.aborted) return;
    selectedOrg.value = result;
    orgOffset.value = offset;
  } catch (cause) {
    if (!current.signal.aborted) orgError.value = cause;
  } finally {
    if (!current.signal.aborted) orgLoading.value = false;
  }
}
async function retryOrganization() {
  if (selectedOrgId.value) await openOrganization(selectedOrgId.value, orgRequestedOffset.value);
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
    <ConsoleSearch :agents-base="`${apiBase}/agents`" :definitions-base="`${apiBase}/definitions`" :kv-base="`${apiBase}/kv`" :search-base="`${apiBase}/search`" :sections-base="sectionsBase" />
    <UDashboardPanel id="auth">
      <template #header>
        <ConsolePageHeader title="Auth" :toggle="false">
          <template #tabs>
            <UTabs
              :model-value="page"
              :items="pageItems"
              :content="false"
              aria-label="Auth pages"
              class="w-max"
              @update:model-value="choosePage"
            />
          </template>
          <template #right>
            <UTooltip text="Refresh">
              <UButton aria-label="Refresh Auth" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :disabled="loading" @click="refresh" />
            </UTooltip>
          </template>
        </ConsolePageHeader>
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
              <UButton :to="appRoot" external size="xs" variant="ghost"
                >Open app</UButton
              ><UButton
                size="xs"
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
            @update:model-value="offset = 0"
            aria-label="Search users by name or email"
            placeholder="Search name or email…"
            icon="i-lucide-search"
            class="min-w-48 flex-1 sm:max-w-72"
          /><USelect
            v-model="filter"
            @update:model-value="offset = 0"
            aria-label="Filter users"
            :items="[
              { label: 'All users', value: 'all' },
              { label: 'Admins', value: 'admins' },
              { label: 'Banned', value: 'banned' },
              ...(description?.pages.includes('agents')
                ? [{ label: 'With agents', value: 'agents' }]
                : []),
            ]"
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
            :enabled="description.events.enabled"
            :revision="revision"
          />
          <ConsoleState
            v-else-if="description && !description.storage.enabled && page !== 'overview'"
            icon="i-vitehub-auth"
            title="No stored Auth data"
            :description="description.storage.reason"
          />
          <p v-else-if="loading" role="status" class="p-4 text-sm text-muted">
            Loading {{ labels[page].toLowerCase() }}…
          </p>
          <div v-else class="min-h-0 flex-1 overflow-auto">
            <div class="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4 sm:p-6">
              <details v-if="description?.access.length && page === 'users'" class="group text-xs text-muted">
                <summary class="inline-flex cursor-pointer items-center gap-1 rounded-md select-none hover:text-highlighted">
                  <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                  Access rules
                </summary>
                <ul class="mt-2 list-inside list-disc space-y-1">
                  <li v-for="rule in description.access" :key="rule">{{ rule }}</li>
                </ul>
              </details>
              <div class="overflow-x-auto rounded-lg border border-default">
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
                  <tr v-for="user in users" :key="user.id" class="relative hover:bg-elevated">
                    <td>
                      <!-- The button overlay makes the whole row open the user. The theme rings the button itself. -->
                      <button
                        class="flex max-w-72 items-center gap-2 rounded-md text-left after:absolute after:inset-0"
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
                        class="rounded-md text-left"
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
                        variant="ghost"
                        size="xs"
                        :disabled="!description?.actions.revokeSession.enabled"
                        :title="description?.actions.revokeSession.reason"
                        @click="
                          action = 'revokeSession';
                          actionId = session.id;
                          actionName = session.user.email;
                        "
                        >Revoke</UButton
                      >
                    </td>
                  </tr>
                </tbody>
                <tbody v-else-if="page === 'organizations'">
                  <tr v-for="org in organizations" :key="org.id" class="relative hover:bg-elevated">
                    <td>
                      <button
                        class="rounded-md text-left font-medium text-highlighted after:absolute after:inset-0"
                        @click="selectedOrgId = org.id"
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
                        class="rounded-md text-left"
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
                        variant="ghost"
                        size="xs"
                        :disabled="!description?.actions.revokeConsent.enabled"
                        @click="
                          action = 'revokeConsent';
                          actionId = client.id;
                          actionName = client.user.email;
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
                  variant="ghost"
                  size="xs"
                  :disabled="offset === 0"
                  @click="offset -= limit"
                  >Previous</UButton
                ><UButton
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
      :id="selectedUser"
      :description="description"
      @close="selectedUser = undefined"
      @changed="refresh"
    />
    <ConsoleAuthAction
      :action="action"
      :id="actionId"
      :name="actionName"
      @close="action = undefined"
      @changed="refresh"
    />
    <USlideover
      :open="Boolean(selectedOrgId)"
      :title="orgName ?? 'Organization'"
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
          :retry="retryOrganization"
        /><p v-else-if="orgLoading" role="status" class="text-sm text-muted">
          Loading organization…
        </p><template v-else-if="selectedOrg"
          ><div class="grid gap-6"><ConsoleSection :level="3" title="Members" :count="selectedOrg.membersTotal">
            <ul class="-mx-2 space-y-0.5">
              <li v-for="member in selectedOrg.members" :key="member.id">
                <button
                  type="button"
                  class="flex w-full justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-elevated"
                  @click="selectedUser = member.user.id"
                >
                  <span class="min-w-0">
                    <span class="block truncate">{{ member.user.name }}</span>
                    <span class="block truncate text-xs text-muted">{{ member.user.email }}</span>
                  </span>
                  <span class="shrink-0 text-muted">{{ member.role }}</span>
                </button>
              </li>
            </ul>
          </ConsoleSection>
          <ConsoleSection :level="3" title="Pending invitations" :count="selectedOrg.invitationsTotal">
            <UEmpty v-if="!selectedOrg.invitationsTotal" variant="naked" size="sm" icon="i-lucide-mail" title="No pending invitations" description="An invitation shows here until the person accepts it or it expires." />
            <ul class="space-y-3">
              <li v-for="invitation in selectedOrg.invitations" :key="invitation.id" class="text-sm">
                <p>
                  {{ invitation.email }} <span class="text-muted">{{ invitation.role }}</span>
                </p>
                <p class="text-xs text-muted">Expires {{ authDate(invitation.expiresAt) }}</p>
              </li>
            </ul>
          </ConsoleSection></div>
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
