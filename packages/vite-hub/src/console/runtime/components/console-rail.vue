<script setup lang="ts">
import { createAuthClient } from "@vite-hub/auth/vue";
import { PrimitiveIcon, PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { defineShortcuts } from "@nuxt/ui/composables";
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleNavigation } from "../client/sections";
import type { ConsoleSectionId } from "../sections";
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance";
import { loadConsoleNavigation, resolveConsoleSectionDetails, subscribeConsoleNavigation } from "../client/sections";
import { decodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import { consoleGoToKey, consoleOverviewShortcut, consoleSectionRailIcon, consoleSectionShortcut, groupConsoleSections } from "../sections";
import ConsoleMark from "./console-mark.vue";

const props = defineProps<{
  /** Section that the current page shows. Leave it unset on the Overview. */
  active?: ConsoleSectionId;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const navigation = shallowRef<ConsoleNavigation>();
const navigationFailed = ref(false);
const signedIn = ref(false);
const signingOut = ref(false);
const signOutFailed = ref(false);
const accessIdentity = ref<{ label?: string; signOutURL: string }>();
const authBase = props.sectionsBase.replace(/\/sections$/, "/auth");
const authClientURL = props.sectionsBase.replace(/\/sections$/, "/client.js");
const signInURL = props.sectionsBase.replace(/\/api\/_vitehub\/console\/sections$/, "/_vitehub/sign-in");
let authClientRequest: Promise<ReturnType<typeof createAuthClient>> | undefined;
let unsubscribe: (() => void) | undefined;

const projectName = computed(() => navigation.value?.projectName || "ViteHub");
const sections = computed(() =>
  (navigation.value?.sections ?? []).flatMap((section) => {
    const details = resolveConsoleSectionDetails(navigation.value, section);
    return details ? [{ id: section, ...details, railIcon: consoleSectionRailIcon(section), shortcut: consoleSectionShortcut(section) }] : [];
  }),
);
// The standalone Console provides its appearance. A Nuxt host owns color mode, so the rail hides the control there.
const appearance = inject(consoleAppearanceKey, undefined);
const currentAppearance = computed(() => consoleAppearanceOptions[appearance?.preference.value ?? "system"]);
const appearanceLabel = computed(() => `Appearance: ${currentAppearance.value.label}`);
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
const signOutLabel = computed(() => (accessIdentity.value?.label ? `Sign out ${accessIdentity.value.label}` : "Sign out"));

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
  if (!result) {
    navigationFailed.value = true;
    return;
  }
  navigation.value = result;
  if (result.auth === "cloudflare-access") void loadAccessIdentity();
  else if (result.auth) void loadAuthSession();
}

async function loadAccessIdentity(): Promise<void> {
  try {
    const response = await fetch(`${authBase}/identity`, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Identity request failed");
    // SAFETY: Reading optional properties is safe for any JSON value; each value is validated below.
    const identity = (await response.json()) as { commonName?: unknown; email?: unknown; signOutURL?: unknown } | null;
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The identity response is untrusted JSON, so validate the same-origin sign-out path.
    if (typeof identity?.signOutURL !== "string" || !identity.signOutURL.startsWith("/") || identity.signOutURL.startsWith("//")) throw new Error("Invalid identity");
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The identity response is untrusted JSON, so validate each label before rendering it.
    const label = typeof identity.email === "string" ? identity.email : typeof identity.commonName === "string" ? identity.commonName : undefined;
    accessIdentity.value = { label, signOutURL: identity.signOutURL };
    signedIn.value = true;
  } catch {
    accessIdentity.value = undefined;
    signedIn.value = false;
  }
}

async function consoleAuthClient(): Promise<ReturnType<typeof createAuthClient>> {
  authClientRequest ??= import(/* @vite-ignore */ authClientURL)
    .then(() => {
      // SAFETY: The generated Console Auth client script is the only writer for this symbol and stores a createAuthClient result.
      return Reflect.get(globalThis, Symbol.for("vitehub.console.auth.client")) as ReturnType<typeof createAuthClient> | undefined;
    })
    .catch(() => undefined)
    .then((configured) => configured ?? createAuthClient({ basePath: authBase }));
  return await authClientRequest;
}

async function loadAuthSession(): Promise<void> {
  try {
    const authClient = await consoleAuthClient();
    const { data } = await authClient.getSession();
    signedIn.value = Boolean(data?.session);
  } catch {
    signedIn.value = false;
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true;
  signOutFailed.value = false;
  if (accessIdentity.value) {
    window.location.assign(accessIdentity.value.signOutURL);
    return;
  }
  try {
    const authClient = await consoleAuthClient();
    const { error } = await authClient.signOut();
    if (error) throw error;
    window.location.assign(signInURL);
  } catch {
    signOutFailed.value = true;
    signingOut.value = false;
  }
}

onMounted(() => {
  window.addEventListener("keydown", trackGoToStart, true);
  window.addEventListener("focusin", invalidateGoToStart);
  window.addEventListener("blur", invalidateGoToStart);
  unsubscribe = subscribeConsoleNavigation(props.sectionsBase, (value) => {
    navigation.value = value;
  });
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
    </template>

    <template #default="{ expanded }">
      <template v-if="!navigation && !navigationFailed">
        <USkeleton v-for="index in 5" :key="index" class="my-px size-9 rounded-md" />
      </template>
      <UTooltip v-if="navigationFailed && !navigation" text="Retry loading primitives" :content="{ side: 'right' }" :disabled="expanded">
        <PrimitiveRailItem label="Retry loading primitives" @click="loadNavigation">
          <UIcon name="i-ph-arrows-clockwise-light" class="size-[1.125rem]" />
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
            <!-- Known primitives use the shared icon family. A contributed section keeps the icon of its descriptor. -->
            <PrimitiveIcon v-if="section.railIcon" :name="section.railIcon" />
            <UIcon v-else :name="section.icon" class="size-[1.125rem]" />
          </PrimitiveRailItem>
        </UTooltip>
      </PrimitiveRailGroup>
    </template>

    <template #footer="{ expanded }">
      <!--
        The search button stays collapsed, because a change to that prop mounts a new button and keyboard focus is lost.
        Its slots give it the same icon box and label as a rail item.
      -->
      <UTooltip text="Search" :content="{ side: 'right' }" :disabled="expanded">
        <UDashboardSearchButton class="vh-primitive-rail__item vitehub-console__rail-search" collapsed label="Search">
          <template #leading>
            <span class="vh-primitive-rail__icon" aria-hidden="true">
              <UIcon name="i-lucide-search" class="size-4" />
            </span>
          </template>
          <span class="vh-primitive-rail__label">Search</span>
        </UDashboardSearchButton>
      </UTooltip>
      <UDropdownMenu
        v-if="appearance"
        :items="appearanceItems"
        :content="{ side: 'right', align: 'end', sideOffset: 8 }"
        :ui="{ content: 'min-w-40' }"
      >
        <UTooltip :text="appearanceLabel" :content="{ side: 'right' }" :disabled="expanded">
          <PrimitiveRailItem :label="appearanceLabel">
            <UIcon :name="currentAppearance.icon" class="size-4" />
          </PrimitiveRailItem>
        </UTooltip>
      </UDropdownMenu>
      <UTooltip v-if="signedIn" :text="signOutFailed ? 'Could not sign out. Try again.' : signOutLabel" :content="{ side: 'right' }" :disabled="expanded">
        <PrimitiveRailItem
          :label="signOutFailed ? 'Retry sign out' : signOutLabel"
          :disabled="signingOut"
          @click="signOut"
        >
          <UIcon :name="signingOut ? 'i-lucide-loader-circle' : 'i-lucide-log-out'" class="size-4" :class="signingOut ? 'animate-spin' : ''" />
        </PrimitiveRailItem>
      </UTooltip>
    </template>
  </PrimitiveRail>
</template>

<style>
.vh-primitive-rail .vitehub-console__rail-home {
  color: var(--ui-text-highlighted);
}

/* The search button is a Nuxt UI button. The rail item class sets its size and states, and its slots set the icon box and label. */
.vitehub-console .vitehub-console__rail-search {
  box-shadow: none !important;
  gap: 0 !important;
  padding: 0 !important;
}

.vitehub-console .vitehub-console__rail-search:not(:hover) {
  background: transparent !important;
}
</style>
