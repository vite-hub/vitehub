<script setup lang="ts">
import { createAuthClient } from "@vite-hub/auth/vue";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleSectionId } from "../sections";
import { loadConsoleNavigation } from "../client/sections";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionDetails } from "../sections";

const props = defineProps<{
  active?: ConsoleSectionId;
  exclude?: ConsoleSectionId[];
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const navigationFailed = ref(false);
const sections = ref<ConsoleSectionId[]>([]);
const signedIn = ref(false);
const signingOut = ref(false);
const signOutFailed = ref(false);
const authBase = props.sectionsBase.replace(/\/sections$/, "/auth");
const authClientURL = props.sectionsBase.replace(/\/sections$/, "/client.js");
const signInURL = props.sectionsBase.replace(/\/api\/_vitehub\/console\/sections$/, "/_vitehub/sign-in");
let authClientRequest: Promise<ReturnType<typeof createAuthClient>> | undefined;
const items = computed(() =>
  sections.value
    .filter((section) => section !== "usage" && !props.exclude?.includes(section))
    .map((section) => ({ id: section, ...consoleSectionDetails[section] })),
);

async function openSection(section: ConsoleSectionId): Promise<void> {
  await router.push({
    name: resolveConsoleRouteName(route.name, consoleSectionDetails[section].routeName),
  });
}

async function loadSections(): Promise<void> {
  navigationFailed.value = false;
  const navigation = await loadConsoleNavigation(props.sectionsBase);
  if (!navigation) {
    navigationFailed.value = true;
    return;
  }
  sections.value = navigation.sections;
  if (navigation.auth) void loadAuthSession();
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
  void loadSections();
});
</script>

<template>
  <div class="flex w-full min-w-0 items-center gap-0.5">
    <nav class="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Console primitives">
      <UTooltip v-for="item in items" :key="item.id" :text="item.label">
        <UButton
          :aria-label="`Open ${item.label}`"
          color="neutral"
          :icon="item.icon"
          size="xs"
          :variant="active === item.id ? 'soft' : 'ghost'"
          @click="openSection(item.id)"
        />
      </UTooltip>
      <UTooltip v-if="sections.includes('usage') && !exclude?.includes('usage')" :text="consoleSectionDetails.usage.label">
        <UButton
          :aria-label="`Open ${consoleSectionDetails.usage.label}`"
          color="neutral"
          :icon="consoleSectionDetails.usage.icon"
          size="xs"
          :variant="active === 'usage' ? 'soft' : 'ghost'"
          @click="openSection('usage')"
        />
      </UTooltip>
      <UTooltip v-if="navigationFailed" text="Retry loading primitives">
        <UButton
          aria-label="Retry loading primitives"
          color="neutral"
          icon="i-ph-arrow-clockwise"
          size="xs"
          variant="ghost"
          @click="loadSections"
        />
      </UTooltip>
    </nav>
    <UTooltip v-if="signedIn" :text="signOutFailed ? 'Could not sign out. Try again.' : 'Sign out'">
      <UButton
        :aria-label="signOutFailed ? 'Retry sign out' : 'Sign out'"
        :loading="signingOut"
        color="neutral"
        icon="i-lucide-log-out"
        size="xs"
        variant="ghost"
        @click="signOut"
      />
    </UTooltip>
  </div>
</template>
