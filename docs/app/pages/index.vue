<script setup lang="ts">
const title = "Agents and Server Primitives for Vite";
const description =
  "Define inspectable Agents with explicit runtime boundaries, then run them on any host with portable Server Primitives for Vite.";

useSeo({
  title,
  description,
  type: "website",
});

defineOgImage("Landing", {
  title,
  description: formatOgDescription(title, description),
});
</script>

<template>
  <UMain class="bg-default text-default">
    <LandingHero />
    <LandingPaths />
    <LandingPrimitives />
  </UMain>
</template>
