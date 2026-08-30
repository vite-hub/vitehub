<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports";

import ConsoleDefinitions from "../components/console-definitions.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

useHead({ title: "Queues · ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleDefinitions
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :definitions-base="`${appBaseURL}/api/_vitehub/console/definitions`"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="`${appBaseURL}/api/_vitehub/console/sections`"
        section="queues"
      />
    </ConsoleProvider>
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
