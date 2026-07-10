<script setup lang="ts">
import { useHead, useSeoMeta } from "#app/composables/head";

useHead({ titleTemplate: () => "ViteHub" });

useSeoMeta({
  title: "ViteHub — Agents for any host",
  ogTitle: "ViteHub — Agents for any host · ViteHub",
  description: "Build portable Agents, or use the same Server Primitives directly in any Vite application.",
});
</script>

<template>
  <UMain class="bg-default text-default">
    <LandingHero />
    <LandingAnyHost />
    <LandingAnatomy />
    <LandingPrimitives />
    <LandingShowcase />
    <LandingCta />
  </UMain>
</template>
