<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { navigateTo, useHead, useRoute, useRuntimeConfig } from "#imports";

import { loadConsoleNavigation } from "../client/sections";
import ConsoleDocuments from "../components/console-documents.vue";
import ConsoleProvider from "../components/console-provider.vue";
import { parseConsoleContributedSection } from "../definitions";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const sectionsBase = `${appBaseURL}/api/_vitehub/console/sections`;
const route = useRoute();
// The Nuxt module stores the owner descriptor in the route meta of each document editor section.
const details = computed(() => parseConsoleContributedSection(route.meta.consoleSectionDetails));
const available = ref(false);

useHead({ title: () => details.value ? `${details.value.label} · ViteHub Console` : "ViteHub Console" });

// Discovery installs the section only when its application module exists, such as server/content.ts.
onMounted(async () => {
  const navigation = await loadConsoleNavigation(sectionsBase);
  if (!details.value || !navigation?.sections.includes(details.value.id)) {
    await navigateTo("/_vitehub");
    return;
  }
  available.value = true;
});
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleDocuments
        v-if="details && available"
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :definitions-base="`${appBaseURL}/api/_vitehub/console/definitions`"
        :details="details"
        :documents-base="`${appBaseURL}/api/_vitehub/console/documents`"
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
