<script setup lang="ts">
import { useHead } from "#imports";
import { injectTooltipProviderContext } from "reka-ui";

const hasAppProvider = injectTooltipProviderContext(null) !== null;

useHead({ script: [{ src: "/api/_vitehub/console/client.js", type: "module" }] });
</script>

<template>
  <slot v-if="hasAppProvider" />
  <UApp v-else :toaster="null">
    <slot />
  </UApp>
</template>
