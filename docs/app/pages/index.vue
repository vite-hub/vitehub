<script setup lang="ts">
import { useHead, useSeoMeta } from "#app/composables/head";

useHead({ titleTemplate: () => "ViteHub" });

useSeoMeta({
  title: "ViteHub — Server primitives and agents for Vite",
  ogTitle: "ViteHub — Server primitives and agents for Vite",
  description: "Use portable Server Primitives directly in your Vite application, or compose them into inspectable Agents with explicit runtime boundaries.",
});
</script>

<template>
  <UMain class="bg-default text-default">
    <LandingHero />
    <LandingRelationship />
    <LandingQuickstarts />
    <LandingCta />
  </UMain>
</template>
