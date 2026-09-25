<script setup lang="ts">
import { useHead, useRuntimeConfig } from "#imports";
import { injectTooltipProviderContext } from "reka-ui";

const hasAppProvider = injectTooltipProviderContext(null) !== null;

const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

useHead({ script: [{ src: `${appBaseURL}/api/_vitehub/console/client.js`, type: "module" }] });
</script>

<template>
  <slot v-if="hasAppProvider" />
  <UApp v-else :toaster="null">
    <slot />
  </UApp>
</template>
