<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports";

import ConsoleKv from "../components/console-kv.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

useHead({ title: "KV · ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleKv
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
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
