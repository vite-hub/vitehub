<script setup lang="ts">
import { PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem } from "@vite-hub/docs/primitive-rail";
import { defineShortcuts } from "@nuxt/ui/composables";
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleNavigation } from "../client/sections";
import type { ConsoleSectionId } from "../sections";
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance";
import { useConsoleProjects } from "../client/project-session";
import { isConsoleSignInRequired } from "../client/request";
import { consoleNavigationError, loadConsoleNavigation, resolveConsoleSectionDetails, subscribeConsoleNavigation } from "../client/sections";
import { decodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import { consoleGoToKey, consoleOverviewShortcut, consoleSectionShortcut, groupConsoleSections } from "../sections";
import ConsoleMark from "./console-mark.vue";
import ConsoleProjectSwitcher from "./console-project-switcher.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";

// Only an `account` Console shows it, so it loads with the Better Auth client.
const ConsoleAccountMenu = defineAsyncComponent(() => import("./console-account-menu.vue"));

const props = defineProps<{
  /** Section that the current page shows. Leave it unset on the Overview. */
  active?: ConsoleSectionId;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const navigation = shallowRef<ConsoleNavigation>();
const navigationFailed = ref(false);
// Loading again cannot help when the project refuses the signature, so the rail offers no retry then.
const signedOut = ref(false);
let unsubscribe: (() => void) | undefined;

const projects = useConsoleProjects();
const projectName = computed(() => navigation.value?.projectName || projects.info.value?.name || "ViteHub");
const sections = computed(() =>
  (navigation.value?.sections ?? []).flatMap((section) => {
    const details = resolveConsoleSectionDetails(navigation.value, section);
    return details ? [{ id: section, ...details, shortcut: consoleSectionShortcut(section) }] : [];
  }),
);
// The standalone Console provides its appearance. A Nuxt host owns color mode, so the rail hides the control there.
const appearance = inject(consoleAppearanceKey, undefined);
const appearanceItems = computed<DropdownMenuItem[]>(() => [
  { type: "label", label: "Appearance" },
  ...consoleAppearances.map((option): DropdownMenuItem => ({
    type: "checkbox",
    icon: consoleAppearanceOptions[option].icon,
    label: consoleAppearanceOptions[option].label,
    checked: appearance?.preference.value === option,
    onSelect: () => appearance?.select(option),
  })),
]);
const groups = computed(() => groupConsoleSections(sections.value));
const appearanceLabel = "Appearance";

async function open(routeName: string): Promise<void> {
  const name = resolveConsoleRouteName(route.name, routeName);
  const agent = decodeAgentRouteParam(route.params.agent);
  await router.push({
    name,
    ...(name === resolveConsoleRouteName(route.name, "vitehub-console-usage") && agent ? { query: { returnAgent: agent } } : {}),
  });
}

// The rail is on every page, so it owns the "Go to" chords. Only enabled sections get one.
// Chords do not run while an input, a textarea, or editable content has focus.
let goToStartedOutsideEditor = false;

function editing(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.matches("input, textarea") || active.isContentEditable);
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

/** Shows the sections of a navigation that this rail or another part of the page loaded, such as the Overview. */
function showNavigation(result: ConsoleNavigation): void {
  navigation.value = result;
  navigationFailed.value = false;
  signedOut.value = false;
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
  <!-- The expanded rail shows each label, so the tooltips turn off while it is open. -->
  <PrimitiveRail class="vitehub-console__rail" label="Console">
    <template #header="{ expanded }">
      <UTooltip :text="`${projectName} overview`" :kbds="[...consoleOverviewShortcut]" :content="{ side: 'right' }" :disabled="expanded">
        <PrimitiveRailItem
          class="vitehub-console__rail-home"
          :current="!active"
          :label="`${projectName} overview`"
          @click="open('vitehub-console')"
        >
          <ConsoleMark class="size-[1.125rem]" />
        </PrimitiveRailItem>
      </UTooltip>
      <ConsoleProjectSwitcher v-if="projects.mode !== 'embedded'" />
    </template>

    <template #default="{ expanded }">
      <template v-if="!navigation && !navigationFailed">
        <USkeleton v-for="index in 5" :key="index" class="my-px size-9 rounded-md" />
      </template>
      <UTooltip v-if="navigationFailed && !navigation && !signedOut" text="Retry loading primitives" :content="{ side: 'right' }" :disabled="expanded">
        <PrimitiveRailItem label="Retry loading primitives" @click="loadNavigation">
          <UIcon name="i-lucide-refresh-cw" class="size-[1.125rem]" />
        </PrimitiveRailItem>
      </UTooltip>
      <PrimitiveRailGroup v-for="(group, index) in groups" :key="index">
        <UTooltip
          v-for="section in group"
          :key="section.id"
          :text="section.label"
          :kbds="section.shortcut ? [...section.shortcut] : undefined"
          :content="{ side: 'right' }"
          :disabled="expanded"
        >
          <PrimitiveRailItem
            :current="section.id === active"
            :label="section.label"
            @click="open(section.routeName)"
          >
            <ConsoleSectionIcon :icon="section.icon" class="size-[1.125rem]" />
          </PrimitiveRailItem>
        </UTooltip>
      </PrimitiveRailGroup>
    </template>

    <template #footer="{ expanded }">
      <!--
        The search button stays collapsed, because a change to that prop mounts a new button and keyboard focus is lost.
        Its slots give it the same icon sandbox and label as a rail item.
      -->
      <UTooltip text="Search" :kbds="['meta', 'k']" :content="{ side: 'right' }" :disabled="expanded">
        <UDashboardSearchButton class="vh-primitive-rail__item vitehub-console__rail-search" collapsed label="Search">
          <template #leading>
            <span class="vh-primitive-rail__icon" aria-hidden="true">
              <UIcon name="i-lucide-search" class="size-4" />
            </span>
          </template>
          <span class="vh-primitive-rail__label">Search</span>
        </UDashboardSearchButton>
      </UTooltip>
      <!-- An `account` Console signs people in to itself, not to the app. -->
      <ConsoleAccountMenu v-if="projects.mode === 'account'" :expanded="expanded" />
      <UDropdownMenu
        v-else-if="appearance"
        :items="appearanceItems"
        :content="{ side: 'right', align: 'end', sideOffset: 8 }"
        :ui="{ content: 'min-w-52' }"
      >
        <UTooltip :text="appearanceLabel" :content="{ side: 'right' }" :disabled="expanded">
          <PrimitiveRailItem :label="appearanceLabel">
            <UIcon name="i-lucide-sun-moon" class="size-[1.125rem]" />
          </PrimitiveRailItem>
        </UTooltip>
      </UDropdownMenu>
    </template>
  </PrimitiveRail>
</template>

<style>
.vh-primitive-rail .vitehub-console__rail-home {
  color: var(--ui-text-highlighted);
}

/* The search button is a Nuxt UI button. The rail item class sets its size and states, and its slots set the icon sandbox and label. */
.vitehub-console .vitehub-console__rail-search {
  box-shadow: none !important;
  gap: 0 !important;
  padding: 0 !important;
}

.vitehub-console .vitehub-console__rail-search:not(:hover) {
  background: transparent !important;
}
</style>
