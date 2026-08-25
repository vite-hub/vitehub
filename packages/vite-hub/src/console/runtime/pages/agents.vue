<script setup lang="ts">
import ConsoleApp from "../components/console-app.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

useHead({ title: "Agents · ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleApp
      :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
      :api-base="`${appBaseURL}/api/_vitehub/console/invocations`"
      :search-base="`${appBaseURL}/api/_vitehub/console/search`"
    />
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
