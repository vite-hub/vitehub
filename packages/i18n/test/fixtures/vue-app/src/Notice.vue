<script setup lang="ts">
import { t } from "@vite-hub/i18n"

const label = t`Notice label`
</script>

<template>
  <aside :title="label">{{ t`Changes saved` }}</aside>
</template>
