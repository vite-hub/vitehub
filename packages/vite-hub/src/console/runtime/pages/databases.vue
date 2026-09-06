<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports";
import { computed } from "vue";
import { useRoute } from "vue-router";

import ConsoleDatabase from "../components/console-database.vue";
import ConsoleProvider from "../components/console-provider.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const route = useRoute();
const view = computed(() =>
  route.name?.toString().startsWith("vitehub-console-databases-schema") ? "schema" : "data",
);

useHead({ title: "Databases · ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleDatabase
        :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
        :database-base="`${appBaseURL}/api/_vitehub/console/database`"
        :definitions-base="`${appBaseURL}/api/_vitehub/console/definitions`"
        :kv-base="`${appBaseURL}/api/_vitehub/console/kv`"
        :search-base="`${appBaseURL}/api/_vitehub/console/search`"
        :sections-base="`${appBaseURL}/api/_vitehub/console/sections`"
        section="databases"
        :view="view"
      />
    </ConsoleProvider>
    <template #fallback>
      <div
        aria-label="Loading ViteHub Console"
        class="flex h-dvh min-h-[32rem] overflow-hidden bg-default"
        role="status"
      >
        <aside
          class="hidden w-72 shrink-0 border-r border-default p-3 lg:grid lg:grid-rows-[auto_auto_1fr] lg:gap-4"
        >
          <USkeleton class="h-8 w-36 rounded" />
          <USkeleton class="h-8 rounded-md" />
          <div class="grid content-start gap-1.5">
            <USkeleton v-for="index in 7" :key="index" class="h-8 rounded-md" />
          </div>
        </aside>
        <main class="min-w-0 flex-1">
          <header class="flex h-14 items-center gap-3 px-4">
            <USkeleton class="h-4 w-40 rounded" />
            <div class="ml-auto flex gap-2">
              <USkeleton v-for="index in 4" :key="index" class="size-8 rounded-md" />
            </div>
          </header>
          <div class="border-y border-default px-3 py-2">
            <USkeleton class="h-8 w-64 rounded-md" />
          </div>
          <div class="grid grid-cols-5 border-b border-default">
            <USkeleton v-for="index in 5" :key="index" class="m-3 h-3 rounded" />
          </div>
          <div v-for="row in 10" :key="row" class="grid h-10 grid-cols-5 border-b border-default">
            <USkeleton v-for="column in 5" :key="column" class="m-3 h-3 rounded" />
          </div>
        </main>
      </div>
    </template>
  </ClientOnly>
</template>
