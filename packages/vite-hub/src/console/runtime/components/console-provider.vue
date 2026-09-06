<script setup lang="ts">
import { injectTooltipProviderContext } from "reka-ui";

const hasAppProvider = injectTooltipProviderContext(null) !== null;
</script>

<template>
  <slot v-if="hasAppProvider" />
  <UApp v-else :toaster="null">
    <slot />
  </UApp>
</template>
