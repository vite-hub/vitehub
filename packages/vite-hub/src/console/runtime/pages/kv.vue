<script setup lang="ts">
import { useHead } from "#imports";

import ConsoleKv from "../components/console-kv.vue";
import ConsoleProvider from "../components/console-provider.vue";

useHead({ title: "KV · ViteHub Console" });
</script>

<template>
  <ClientOnly>
    <ConsoleProvider>
      <ConsoleKv />
    </ConsoleProvider>
    <template #fallback>
      <div class="flex h-dvh min-h-[32rem] items-center justify-center text-sm text-muted">
        Loading ViteHub Console…
      </div>
    </template>
  </ClientOnly>
</template>
