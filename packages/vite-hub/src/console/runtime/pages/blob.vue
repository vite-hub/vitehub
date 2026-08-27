<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports";

import ConsoleBlob from "../components/console-blob.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

useHead({ title: "Blob · ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleBlob
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :blob-base="`${appBaseURL}/api/_vitehub/console/blob`"
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
