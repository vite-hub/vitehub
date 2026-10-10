<script setup lang="ts">
const title = "Server primitives for Vite";
const description =
  "Write server code once and deploy it across supported Vite hosts with one API for storage, queues, workflows, and more.";

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
    description: "The open-source server layer for portable Vite applications.",
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
      "One server API for every supported host",
      "Server primitives for storage, queues, and workflows",
      "Inspectable provider output for production",
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
    <LandingPortability />
    <LandingClosing />
  </UMain>
</template>
