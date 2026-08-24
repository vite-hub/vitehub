<script setup lang="ts">
import ConsoleApp from "../components/console-app.vue";

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

useHead({ title: "Agents · ViteHub Console" });
</script>

<template>
  <ConsoleApp
    :agents-base="`${appBaseURL}/api/_vitehub/console/agents`"
    :api-base="`${appBaseURL}/api/_vitehub/console/invocations`"
  />
</template>
