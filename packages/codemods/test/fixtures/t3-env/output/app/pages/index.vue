<script setup lang="ts">
import { env } from "~~/env";
import { usePublicEnv } from "#vitehub/env/public";

const appUrl = usePublicEnv().appUrl;
const port = env.SMTP_PORT;
</script>

<template>
  <a :href="appUrl">{{ port }}</a>
</template>
