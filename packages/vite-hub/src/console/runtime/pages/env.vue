<script setup lang="ts">
import { navigateTo, onMounted, ref, useHead, useRuntimeConfig } from "#imports";

import { requestConsole } from "../client/request";
import { isConsoleSectionId } from "../sections";
import ConsoleEnv from "../components/console-env.vue";
import ConsoleProvider from "../components/console-provider.vue";
import ConsoleState from "../components/console-state.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const sectionsBase = `${appBaseURL}/api/_vitehub/console/sections`;
const available = ref(false);
const loadError = ref<unknown>();

useHead({ title: "Env · ViteHub Console" });

async function loadSections() {
  loadError.value = undefined;
  try {
    const value = await requestConsole(sectionsBase);
    const sections =
      value instanceof Object && "sections" in value && Array.isArray(value.sections)
        ? value.sections.filter(isConsoleSectionId)
        : [];
    if (!sections.includes("env")) {
      await navigateTo("/_vitehub");
      return;
    }
    available.value = true;
  } catch (cause) {
    loadError.value = cause;
  }
}

onMounted(loadSections);
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleEnv
        v-if="available"
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :definitions-base="`${appBaseURL}/api/_vitehub/console/definitions`"
        :kv-base="`${appBaseURL}/api/_vitehub/console/kv`"
        :env-base="`${appBaseURL}/api/_vitehub/console/env`"
        :management-base="`${appBaseURL}/_vitehub/env/manage`"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="sectionsBase"
      />
      <div v-else-if="loadError" class="flex h-dvh min-h-[32rem] items-center justify-center px-4">
        <ConsoleState :error="loadError" title="Could not load the ViteHub Console" :retry="loadSections" />
      </div>
      <div v-else class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </ConsoleProvider>
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
