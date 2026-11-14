<script setup lang="ts">
import { defineShortcuts } from "@nuxt/ui/composables";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleNavigation } from "../client/sections";
import type { ConsoleSectionId } from "../sections";
import { setConsoleNavigationName, useConsoleApp } from "../client/app-identity";
import { operationItems } from "../client/operation-view";
import { showConsoleAccountPage, useConsoleProjects } from "../client/project-session";
import { isConsoleSignInRequired, requestConsoleOperation } from "../client/request";
import { consoleNavigationError, loadConsoleNavigation, resolveConsoleSectionDetails, subscribeConsoleNavigation } from "../client/sections";
import { closeConsoleSidebarDrawer, consoleAddPrimitiveOpen, openConsoleSearch, toggleConsoleSidebar } from "../client/sidebar";
import { decodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import { consoleGoToKey, consoleOverviewShortcut, consoleSectionGroupLabels, consoleSectionShortcut, groupConsoleSections, resolveConsoleSectionGroup } from "../sections";
import ConsoleProjectSwitcher from "./console-project-switcher.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";
import ConsoleSidebar from "./console-sidebar.vue";
import ConsoleSidebarItem from "./console-sidebar-item.vue";
import ConsoleUserMenu from "./console-user-menu.vue";

// Only an `account` Console shows it, so it loads with the Better Auth client.
const ConsoleAccountMenu = defineAsyncComponent(() => import("./console-account-menu.vue"));

/**
 * The sidebar of an open app: the app tile, Overview, the app's sections in groups, and Add a primitive. It owns the
 * "Go to" chords and the `[` key that opens and closes the sidebar, because it is on every page of an app.
 */
const props = defineProps<{
  /** Section that the current page shows. Leave it unset on the Overview. */
  active?: ConsoleSectionId;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const navigation = shallowRef<ConsoleNavigation>();
const navigationFailed = ref(false);
// Loading again cannot help when the project refuses the signature, so the sidebar offers no retry then.
const signedOut = ref(false);
let unsubscribe: (() => void) | undefined;

const projects = useConsoleProjects();
const app = useConsoleApp();
const team = computed(() => projects.account.value?.teams.find(item => item.id === projects.account.value?.teamId)?.name);
const sections = computed(() =>
  (navigation.value?.sections ?? []).flatMap((section) => {
    const details = resolveConsoleSectionDetails(navigation.value, section);
    return details ? [{ id: section, ...details, shortcut: consoleSectionShortcut(section) }] : [];
  }),
);
// Setup changes the app, not its data, so it sits under the Overview with the app's own pages.
const setup = computed(() => sections.value.find(section => section.id === "setup"));
const groups = computed(() =>
  groupConsoleSections(sections.value.filter(section => section.id !== "setup")).map(items => ({
    label: consoleSectionGroupLabels[resolveConsoleSectionGroup(items[0]!.id)],
    items,
  })),
);

// The brand row leads to the apps of the team. An embedded Console has one app, so its home is the Overview.

async function open(routeName: string): Promise<void> {
  const name = resolveConsoleRouteName(route.name, routeName);
  const agent = decodeAgentRouteParam(route.params.agent);
  closeConsoleSidebarDrawer();
  await router.push({
    name,
    ...(name === resolveConsoleRouteName(route.name, "vitehub-console-usage") && agent ? { query: { returnAgent: agent } } : {}),
  });
}

function goHome(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  if (projects.mode === "account") showConsoleAccountPage("home");
  else void open("vitehub-console");
}

function search(): void {
  closeConsoleSidebarDrawer();
  openConsoleSearch();
}

function addPrimitive(): void {
  closeConsoleSidebarDrawer();
  consoleAddPrimitiveOpen.value = true;
}

// The number of open threads of a section whose list has an `open` filter, such as Comments. The count reloads when
// the person leaves the section, where they resolve threads.
const openCounts = shallowRef<Readonly<Record<string, string>>>({});
const countLimit = 100;

async function loadOpenCounts(): Promise<void> {
  const counts: Record<string, string> = {};
  await Promise.all(Object.values(navigation.value?.contributions ?? {}).map(async (section) => {
    if (section.view.kind !== "operation-view" || !navigation.value?.sections.includes(section.id)) return;
    const filter = section.view.filters?.find(item => item.id === "open");
    if (!filter) return;
    const items = operationItems(await requestConsoleOperation(section.view.operation, { ...filter.input, limit: countLimit }).catch(() => undefined));
    if (items.length) counts[section.id] = items.length >= countLimit ? `${countLimit - 1}+` : String(items.length);
  }));
  openCounts.value = counts;
}

watch(() => props.active, (active, previous) => {
  if (previous && openCounts.value[previous] !== undefined && active !== previous) void loadOpenCounts();
});

// The sidebar is on every page, so it owns the "Go to" chords. Only enabled sections get one.
// Chords do not run while an input, a textarea, or editable content has focus.
let goToStartedOutsideEditor = false;

function editing(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.matches("input, textarea, select") || active.isContentEditable);
}

function trackGoToStart(event: KeyboardEvent): void {
  // Nuxt UI records chained keys before checking focus. Check the first key too.
  if (editing() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) goToStartedOutsideEditor = false;
  else if (event.key === consoleGoToKey) goToStartedOutsideEditor = true;
}

function invalidateGoToStart(): void {
  goToStartedOutsideEditor = false;
}

function openShortcut(routeName: string): void {
  if (goToStartedOutsideEditor && !editing()) void open(routeName);
  invalidateGoToStart();
}

defineShortcuts(
  computed(() => {
    const shortcuts: Record<string, () => void> = {
      [consoleOverviewShortcut.join("-")]: () => openShortcut("vitehub-console"),
      "[": () => { if (!editing()) toggleConsoleSidebar(); },
    };
    for (const section of sections.value) {
      if (section.shortcut) shortcuts[section.shortcut.join("-")] = () => openShortcut(section.routeName);
    }
    return shortcuts;
  }),
);

async function loadNavigation(): Promise<void> {
  navigationFailed.value = false;
  const result = await loadConsoleNavigation(props.sectionsBase);
  if (result) {
    showNavigation(result);
    return;
  }
  navigationFailed.value = true;
  signedOut.value = isConsoleSignInRequired(consoleNavigationError(props.sectionsBase));
}

/** Shows the sections of a navigation that this sidebar or another part of the page loaded, such as the Overview. */
function showNavigation(result: ConsoleNavigation): void {
  navigation.value = result;
  setConsoleNavigationName(result.projectName);
  navigationFailed.value = false;
  signedOut.value = false;
  void loadOpenCounts();
}

onMounted(() => {
  window.addEventListener("keydown", trackGoToStart, true);
  window.addEventListener("focusin", invalidateGoToStart);
  window.addEventListener("blur", invalidateGoToStart);
  unsubscribe = subscribeConsoleNavigation(props.sectionsBase, showNavigation);
  void loadNavigation();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", trackGoToStart, true);
  window.removeEventListener("focusin", invalidateGoToStart);
  window.removeEventListener("blur", invalidateGoToStart);
  unsubscribe?.();
});
</script>

<template>
  <ConsoleSidebar :home-href="projects.home" :home-label="projects.mode === 'account' ? 'ViteHub, all apps' : `${app.name} overview`" :team="team" @home="goHome" @search="search">
    <template #app>
      <ConsoleProjectSwitcher :app="app" />
    </template>

    <ConsoleSidebarItem label="Overview" icon="i-lucide-gauge" :current="!active" :shortcut="consoleOverviewShortcut" @click="open('vitehub-console')" />
    <ConsoleSidebarItem v-if="setup" :label="setup.label" :current="active === 'setup'" :shortcut="setup.shortcut" @click="open(setup.routeName)">
      <template #icon><ConsoleSectionIcon :icon="setup.icon" /></template>
    </ConsoleSidebarItem>

    <template v-if="!navigation && !navigationFailed">
      <USkeleton v-for="index in 5" :key="index" class="mx-[0.5625rem] my-2 size-[1.125rem] shrink-0 rounded-sm" />
    </template>
    <ConsoleSidebarItem v-if="navigationFailed && !navigation && !signedOut" label="Retry loading primitives" icon="i-lucide-refresh-cw" @click="loadNavigation" />

    <div v-for="group in groups" :key="group.label" class="vitehub-sidebar__group" role="group" :aria-label="group.label">
      <div class="vitehub-sidebar__group-label" aria-hidden="true">{{ group.label }}</div>
      <ConsoleSidebarItem
        v-for="section in group.items"
        :key="section.id"
        :label="section.label"
        :current="section.id === active"
        :shortcut="section.shortcut"
        :badge="openCounts[section.id]"
        badge-label="open"
        @click="open(section.routeName)"
      >
        <template #icon><ConsoleSectionIcon :icon="section.icon" /></template>
      </ConsoleSidebarItem>
    </div>

    <div v-if="navigation" class="vitehub-sidebar__group">
      <ConsoleSidebarItem class="vitehub-sidebar__quiet" label="Add a primitive" icon="i-lucide-plus" @click="addPrimitive" />
    </div>

    <template #footer>
      <!-- An `account` Console signs people in to itself, not to the app. -->
      <ConsoleAccountMenu v-if="projects.mode === 'account'" />
      <ConsoleUserMenu v-else />
    </template>
  </ConsoleSidebar>
</template>
