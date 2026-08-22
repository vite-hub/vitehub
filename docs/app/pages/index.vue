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

useSchemaOrg([
  defineOrganization({
    name: "ViteHub",
    description: "The open-source project that builds portable Agents and Server Primitives for Vite applications.",
    url: "https://vitehub.dev",
    logo: "https://vitehub.dev/vitehub-logo.png",
    sameAs: [
      "https://github.com/vite-hub",
      "https://www.npmjs.com/package/vite-hub",
    ],
  }),
  defineSoftwareApp({
    name: "ViteHub",
    description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform",
    downloadUrl: "https://www.npmjs.com/package/vite-hub",
    featureList: [
      "Portable Server Primitives for Vite applications",
      "Inspectable Agent Definitions and Capabilities",
      "Provider Output for supported deployment hosts",
    ],
    offers: {
      price: 0,
      priceCurrency: "USD",
      url: "https://www.npmjs.com/package/vite-hub",
    },
  }),
]);
</script>

<template>
  <UMain class="bg-default text-default">
    <LandingHero />
    <LandingPaths />
    <LandingPrimitives />
  </UMain>
</template>
