<script setup lang="ts">
import { useHead, useSeoMeta } from "#app/composables/head";

useHead({ titleTemplate: () => "ViteHub" });

useSeoMeta({
  title: "ViteHub — Agents for any host",
  ogTitle: "ViteHub — Agents for any host · ViteHub",
  description: "Compose agents with server primitives for databases, storage, workflows, schedules, and workspaces through one Vite plugin.",
});
</script>

<template>
  <LandingHero />
</template>
