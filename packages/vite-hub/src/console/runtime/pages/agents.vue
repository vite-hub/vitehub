<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports";
import { computed } from "vue";
import { useRoute } from "vue-router";

import ConsoleApp from "../components/console-app.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const route = useRoute();

useHead({ title: computed(() => route.name?.toString().startsWith("vitehub-console-usage")
  ? "Usage · ViteHub Console"
  : "Agents · ViteHub Console") });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleApp
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :api-base="`${appBaseURL}/api/_vitehub/console/invocations`"
        :host-base="appBaseURL"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="`${appBaseURL}/api/_vitehub/console/sections`"
        :usage-base="`${appBaseURL}/api/_vitehub/console/usage`"
      />
    </ConsoleProvider>
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
