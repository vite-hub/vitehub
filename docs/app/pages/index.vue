<script setup lang="ts">
import { useHead, useSeoMeta } from "#app/composables/head";

useHead({ titleTemplate: () => "ViteHub" });

useSeoMeta({
  title: "ViteHub — Agents for any host",
  ogTitle: "ViteHub — Agents for any host · ViteHub",
  description: "Define any agent, compose it from capabilities, and ship it to any host — built on server primitives, wired with one Vite plugin.",
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
