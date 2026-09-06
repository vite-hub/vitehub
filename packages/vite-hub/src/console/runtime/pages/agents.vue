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
        :capabilities-base="`${appBaseURL}/api/_vitehub/console/invocation-capabilities`"
        :definitions-base="`${appBaseURL}/api/_vitehub/console/definitions`"
        :kv-base="`${appBaseURL}/api/_vitehub/console/kv`"
        :host-base="appBaseURL"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="`${appBaseURL}/api/_vitehub/console/sections`"
        :usage-base="`${appBaseURL}/api/_vitehub/console/usage`"
      />
    </ConsoleProvider>
    <template #fallback>
      <div
        aria-label="Loading ViteHub Console"
        class="flex h-dvh min-h-[32rem] overflow-hidden bg-default"
        role="status"
      >
        <aside class="hidden w-80 shrink-0 border-r border-default p-4 lg:grid lg:grid-rows-[auto_auto_1fr] lg:gap-5">
          <USkeleton class="h-8 w-36 rounded" />
          <USkeleton class="h-9 rounded-lg" />
          <div class="grid content-start gap-3">
            <USkeleton v-for="index in 5" :key="index" class="h-16 rounded-lg" />
          </div>
        </aside>
        <main class="min-w-0 flex-1">
          <header class="flex h-14 items-center border-b border-default px-6">
            <USkeleton class="h-5 w-72 max-w-3/5 rounded" />
          </header>
          <div class="grid gap-6 px-6 py-10 sm:px-10 lg:px-14">
            <USkeleton class="h-14 rounded-lg" />
            <USkeleton class="mx-auto h-72 w-full max-w-3xl rounded-3xl" />
            <USkeleton class="h-12 rounded-lg" />
          </div>
        </main>
      </div>
    </template>
  </ClientOnly>
</template>
