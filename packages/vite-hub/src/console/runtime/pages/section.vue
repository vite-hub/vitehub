<script setup lang="ts">
import { computed } from "vue";
import { useHead, useRoute, useRuntimeConfig } from "#imports";

import ConsoleDefinitions from "../components/console-definitions.vue";
import ConsoleProvider from "../components/console-provider.vue";
import { parseConsoleContributedSection } from "../definitions";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const route = useRoute();
// The Nuxt module stores the owner descriptor in the route meta of each contributed section.
const details = computed(() => parseConsoleContributedSection(route.meta.consoleSectionDetails));

useHead({ title: () => details.value ? `${details.value.label} · ViteHub Console` : "ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleDefinitions
        v-if="details"
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :definitions-base="`${appBaseURL}/api/_vitehub/console/definitions`"
        :details="details"
        :kv-base="`${appBaseURL}/api/_vitehub/console/kv`"
        :schedule-run-base="`${appBaseURL}/api/_vitehub/console/schedule-run`"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="`${appBaseURL}/api/_vitehub/console/sections`"
      />
    </ConsoleProvider>
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
