<script setup lang="ts">
import { useHead, useSeoMeta } from "#app/composables/head";

useHead({ titleTemplate: () => "ViteHub" });

useSeoMeta({
  title: "ViteHub — Server primitives for every host",
  ogTitle: "ViteHub — Server primitives for every host · ViteHub",
  description: "Database, analytics, blob, cache, email, KV, vector, queues, workflows, cron, sandbox, and browser. One API surface, any provider.",
});
</script>

<template>
  <LandingHero />
</template>
