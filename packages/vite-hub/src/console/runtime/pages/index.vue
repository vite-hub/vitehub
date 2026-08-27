<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports"

import ConsoleHome from "../components/console-home.vue"
import ConsoleProvider from "../components/console-provider.vue"

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "")

useHead({ title: "ViteHub Console" })
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleHome :sections-base="`${appBaseURL}/api/_vitehub/console/sections`" />
    </ConsoleProvider>
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
