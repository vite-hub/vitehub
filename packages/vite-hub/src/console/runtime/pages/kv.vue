<script setup lang="ts">
import { navigateTo, onMounted, ref, useHead, useRuntimeConfig } from "#imports";

import { requestConsole } from "../client/request";
import { isConsoleSectionId } from "../sections";
import ConsoleKv from "../components/console-kv.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const sectionsBase = `${appBaseURL}/api/_vitehub/console/sections`;
const available = ref(false);

useHead({ title: "KV · ViteHub Console" });

onMounted(async () => {
  const value = await requestConsole(sectionsBase);
  const sections = value instanceof Object && "sections" in value && Array.isArray(value.sections)
    ? value.sections.filter(isConsoleSectionId)
    : [];
  if (!sections.includes("kv")) {
    await navigateTo(`${appBaseURL}/_vitehub`);
    return;
  }
  available.value = true;
});
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleKv
        v-if="available"
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :kv-base="`${appBaseURL}/api/_vitehub/console/kv`"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="sectionsBase"
      />
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
