<script setup lang="ts">
import { Status, type StatusTone } from "@vite-hub/ui";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleAccountAppStatus, ConsoleAccountCheck } from "../client/account";
import type { ConsoleNavigation } from "../client/sections";
import { accountAppStatusLabels, checkConsoleAccountProject } from "../client/account";
import { useConsoleApp } from "../client/app-identity";
import { canManageConsoleProjects, useConsoleProjects } from "../client/project-session";
import { loadConsoleNavigation, resolveConsoleSectionDetails, subscribeConsoleNavigation } from "../client/sections";
import { consoleAddPrimitiveOpen } from "../client/sidebar";
import { resolveConsoleRouteName } from "../console-route";
import ConsoleAccountUnlink from "./console-account-unlink.vue";
import ConsoleAppLogo from "./console-app-logo.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";
import ConsoleSettings from "./console-settings.vue";
import ConsoleSettingsCard from "./console-settings-card.vue";
import ConsoleSettingsValue from "./console-settings-value.vue";

/**
 * The Settings page of an app: what the Console knows about the app, where each value comes from, the primitives that
 * the app turned on, and, in an `account` Console, the link to the app.
 */
const props = defineProps<{ sectionsBase: string }>();

const route = useRoute();
const router = useRouter();
const projects = useConsoleProjects();
const app = useConsoleApp();
const current = computed(() => projects.current.value);
// An `account` Console links the app with a key. An embedded Console runs in the app, so it has no link.
const link = computed(() => projects.mode === "account" ? projects.account.value?.projects.find(project => project.id === current.value?.id) : undefined);
const manage = computed(() => projects.account.value ? canManageConsoleProjects(projects.account.value) : false);
const origin = computed(() => current.value ? new URL(current.value.url).origin : window.location.origin);

const sections = computed(() => [
  { id: "general", label: "General" },
  { id: "primitives", label: "Primitives" },
  ...(link.value ? [{ id: "connection", label: "Connection" }] : []),
  ...(link.value && manage.value ? [{ id: "danger", label: "Danger zone" }] : []),
].map(item => ({ ...item, href: router.resolve(settingsRoute(item.id)).href })));
const section = computed(() => {
  const requested = String(route.params.section ?? "");
  return sections.value.some(item => item.id === requested) ? requested : "general";
});

function settingsRoute(id: string) {
  return { name: resolveConsoleRouteName(route.name, "vitehub-console-app-settings"), params: id === "general" ? {} : { section: id } };
}

function select(id: string): void {
  void router.push(settingsRoute(id));
}

// The sidebar loads the same navigation, so the primitives are usually there when the page opens.
const navigation = shallowRef<ConsoleNavigation>();
const navigationFailed = ref(false);
const primitives = computed(() =>
  (navigation.value?.sections ?? []).flatMap((id) => {
    const details = resolveConsoleSectionDetails(navigation.value, id);
    return details ? [{ id, ...details }] : [];
  }),
);

async function loadNavigation(): Promise<void> {
  navigationFailed.value = false;
  const result = await loadConsoleNavigation(props.sectionsBase);
  if (result) navigation.value = result;
  else navigationFailed.value = true;
}

function addPrimitive(): void {
  consoleAddPrimitiveOpen.value = true;
}

function openPrimitive(routeName: string): void {
  void router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

const statusTones: Record<ConsoleAccountAppStatus, StatusTone> = {
  checking: "neutral",
  connected: "success",
  setup: "warning",
  unconfigured: "warning",
  unreachable: "error",
};
const check = shallowRef<ConsoleAccountCheck & { at: Date }>();
const checking = ref(false);
const checkFailed = ref(false);
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The Console server calls the app with a signed request, as Home does for every app. */
async function runCheck(): Promise<void> {
  const id = link.value?.id;
  if (!id || checking.value) return;
  checking.value = true;
  checkFailed.value = false;
  try {
    check.value = { ...await checkConsoleAccountProject(id), at: new Date() };
  }
  catch {
    checkFailed.value = true;
  }
  checking.value = false;
}

watch(section, (value) => {
  if (value === "connection" && !check.value) void runCheck();
}, { immediate: true });

const unlinking = ref(false);

let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = subscribeConsoleNavigation(props.sectionsBase, (result) => { navigation.value = result; });
  void loadNavigation();
});
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <UDashboardPanel id="console-app-settings">
    <template #header>
      <ConsolePageHeader title="Settings" :toggle="false" />
    </template>

    <template #body>
      <main class="px-5 pb-24 pt-8 sm:px-8 lg:pt-12">
        <ConsoleSettings label="App settings" :sections="sections" :current="section" @select="select">
          <template v-if="section === 'general'">
            <ConsoleSettingsCard title="App name" description="The name that the Console shows for this app.">
              <ConsoleSettingsValue label="App name" :value="app.name" />
              <template #footer>
                <template v-if="projects.info.value?.name || navigation?.projectName">Set by <code>name</code> in the app's <code>package.json</code>, or its folder name. Change it there and deploy.</template>
                <template v-else>The app did not report a name, so the Console shows its address.</template>
              </template>
            </ConsoleSettingsCard>

            <ConsoleSettingsCard title="App icon" description="The Console shows the site's favicon. Without one, it shows the first letter of the name.">
              <div class="flex items-center gap-3">
                <ConsoleAppLogo :app="app" class="vitehub-app-settings__logo" />
                <span class="truncate font-mono text-[0.8125rem] text-muted">{{ origin }}/favicon.ico</span>
              </div>
              <template #footer>The app serves it at <code>/favicon.ico</code>. Change that file and deploy.</template>
            </ConsoleSettingsCard>

            <ConsoleSettingsCard title="URL" description="Where the app runs. The Console sends its calls to this address.">
              <ConsoleSettingsValue label="URL" :value="current?.url" copy>
                <a :href="current?.url" target="_blank" rel="noreferrer" class="hover:underline">{{ app.host || current?.url }}</a>
              </ConsoleSettingsValue>
              <template #footer>
                <template v-if="link">The address that the app was linked with. To change it, unlink the app and link the new address.</template>
                <template v-else>The address of this page. The Console runs in the app.</template>
              </template>
            </ConsoleSettingsCard>

            <ConsoleSettingsCard v-if="link" title="App ID" description="The ID of this app in the Console. Links such as ?app= use it.">
              <ConsoleSettingsValue label="App ID" :value="link.id" mono copy />
              <template #footer>The Console made it when the app was linked.</template>
            </ConsoleSettingsCard>

            <ConsoleSettingsCard v-if="projects.info.value?.vitehub" title="ViteHub version" description="The version of the vite-hub package that the app runs.">
              <ConsoleSettingsValue label="ViteHub version" :value="projects.info.value.vitehub" mono />
              <template #footer>The app reports it to the Console. Update <code>vite-hub</code> in <code>package.json</code> and deploy.</template>
            </ConsoleSettingsCard>
          </template>

          <template v-else-if="section === 'primitives'">
            <ConsoleSettingsCard title="Primitives in this app" description="The app turns primitives on in its code. The Console shows each one that has a page.">
              <ul class="vitehub-app-settings__list">
                <template v-if="!navigation && !navigationFailed">
                  <li v-for="index in 3" :key="index" class="vitehub-app-settings__row" aria-hidden="true">
                    <USkeleton class="size-4 shrink-0 rounded-sm" />
                    <USkeleton class="h-3 w-24" />
                    <USkeleton class="h-3 flex-1" />
                  </li>
                </template>
                <li v-else-if="navigationFailed" class="vitehub-app-settings__row">
                  <span class="flex-1 text-muted" role="alert">The primitives did not load.</span>
                  <UButton size="xs" color="neutral" variant="ghost" label="Retry" @click="loadNavigation" />
                </li>
                <li v-else-if="!primitives.length" class="vitehub-app-settings__row text-muted">No primitive in this app has a Console page yet.</li>
                <li v-for="primitive in primitives" :key="primitive.id" class="vitehub-app-settings__row">
                  <ConsoleSectionIcon :icon="primitive.icon" class="size-4 shrink-0 text-muted" />
                  <span class="w-32 shrink-0 truncate font-medium text-highlighted">{{ primitive.label }}</span>
                  <span class="hidden min-w-0 flex-1 truncate text-muted sm:block" :title="primitive.description">{{ primitive.description }}</span>
                  <UButton class="ms-auto" size="xs" color="neutral" variant="ghost" label="Open" :aria-label="`Open ${primitive.label}`" @click="openPrimitive(primitive.routeName)" />
                </li>
              </ul>
              <template #footer>
                <template v-if="navigation?.scoped">Your access shows some of the app's primitives.</template>
                <template v-else>Set in the ViteHub config of the app, such as <code>vite.config.ts</code> or <code>nuxt.config.ts</code>.</template>
              </template>
              <template #action>
                <UButton size="sm" icon="i-lucide-plus" label="Add a primitive" @click="addPrimitive" />
              </template>
            </ConsoleSettingsCard>
          </template>

          <template v-else-if="section === 'connection' && link">
            <ConsoleSettingsCard title="Console key" description="The app checks each Console call with this public key. The Console server keeps the private key.">
              <div class="grid gap-2">
                <ConsoleSettingsValue label="Variable name" :value="link.keyVariable" mono copy />
                <ConsoleSettingsValue label="Public key" :value="link.publicKey" mono copy />
              </div>
              <template #footer>Set as an environment variable of the app. Linking the app again makes a new key.</template>
            </ConsoleSettingsCard>

            <ConsoleSettingsCard title="Connection check" description="The Console server calls the app with a signed request. Home checks every app the same way.">
              <p class="flex min-h-8 items-center gap-2 text-sm text-highlighted" role="status">
                <USkeleton v-if="!check && !checkFailed" class="h-3 w-48" />
                <template v-else-if="checkFailed">
                  <Status tone="error" />
                  The Console server did not answer.
                </template>
                <template v-else-if="check">
                  <Status :tone="statusTones[check.status]" />
                  {{ accountAppStatusLabels[check.status] }}
                  <span class="text-muted">· HTTP {{ check.code }}</span>
                </template>
              </p>
              <template #footer>{{ check ? `Checked at ${timeFormat.format(check.at)}.` : "Checking…" }}</template>
              <template #action>
                <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" label="Check again" :loading="checking" @click="runCheck" />
              </template>
            </ConsoleSettingsCard>
          </template>

          <template v-else-if="section === 'danger' && link">
            <ConsoleSettingsCard title="Unlink app" :description="`The Console forgets ${app.name} for the whole team. The site keeps running.`" danger>
              <template #footer>After this, the key variable on the app stops working. Remove it from the app.</template>
              <template #action>
                <UButton size="sm" color="error" variant="outline" icon="i-lucide-unlink" label="Unlink" @click="unlinking = true" />
              </template>
            </ConsoleSettingsCard>
            <ConsoleAccountUnlink v-model:open="unlinking" :project-id="link.id" :name="app.name" />
          </template>
        </ConsoleSettings>
      </main>
    </template>
  </UDashboardPanel>
</template>

<style>
.vitehub-app-settings__logo {
  border-radius: 0.625rem;
  font-size: 1.125rem;
  height: 3rem;
  width: 3rem;
}

.vitehub-app-settings__list {
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  font-size: 0.8125rem;
}

.vitehub-app-settings__row {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  min-height: 2.5rem;
  padding: 0.25rem 0.5rem 0.25rem 0.75rem;
}

.vitehub-app-settings__row + .vitehub-app-settings__row {
  border-top: 1px solid var(--ui-border);
}
</style>
