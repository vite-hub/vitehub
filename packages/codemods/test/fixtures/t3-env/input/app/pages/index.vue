<script setup lang="ts">
import { env } from "~~/env";

const appUrl = env.NUXT_PUBLIC_APP_URL;
const port = env.SMTP_PORT;
</script>

<template>
  <a :href="appUrl">{{ port }}</a>
</template>
