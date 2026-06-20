<script setup lang="ts">
import { useHead, useSeoMeta } from "#app/composables/head";

useHead({ titleTemplate: () => "ViteHub" });

useSeoMeta({
  title: "ViteHub — Agents and server primitives for any host",
  ogTitle: "ViteHub — Agents and server primitives for any host · ViteHub",
  description: "Build Agent Definitions with controlled Capabilities, Workspaces, Sources, KV, Blob, Database, Queue, Workflow, Schedule, Sandbox, Shell, Auth, and Env.",
});
</script>

<template>
  <LandingHero />
</template>
