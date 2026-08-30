<script setup lang="ts">
import { navigateTo, onMounted, ref, useHead, useRuntimeConfig } from "#imports";

import { requestConsole } from "../client/request";
import { isConsoleSectionId } from "../sections";
import ConsoleKv from "../components/console-kv.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const sectionsBase = `${appBaseURL}/api/_vitehub/console/sections`;
const available = ref(false);
const loadError = ref(false);

useHead({ title: "KV · ViteHub Console" });

async function loadSections() {
  loadError.value = false;
  try {
    const value = await requestConsole(sectionsBase);
    const sections = value instanceof Object && "sections" in value && Array.isArray(value.sections)
      ? value.sections.filter(isConsoleSectionId)
      : [];
    if (!sections.includes("kv")) {
      await navigateTo("/_vitehub");
      return;
    }
    available.value = true;
  }
  catch {
    loadError.value = true;
  }
}

onMounted(loadSections);
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
      <div v-else-if="loadError" class="flex h-dvh min-h-[32rem] items-center justify-center px-4">
        <UAlert
          class="max-w-md"
          color="error"
          variant="subtle"
          icon="i-ph-cloud-slash-light"
          title="Could not load the ViteHub Console"
          :actions="[{ label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadSections }]"
        />
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
