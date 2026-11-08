<script setup lang="ts">
const title = "Server primitives and Agents for Vite apps";
const description =
  "ViteHub is an open-source Vite plugin. Use one API for databases, storage, queues, workflows, and AI Agents, and deploy to Cloudflare, Vercel, Netlify, or Node.";

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogType: "website",
  ogUrl: "https://vitehub.dev",
});

// The home page is a Vue page. `content/index.md` is its Markdown twin for agents.
useHead({ link: [{ rel: "alternate", type: "text/markdown", href: "https://vitehub.dev/raw/index.md" }] });

useSchemaOrg([
  defineWebSite({
    name: "ViteHub",
    description,
  }),
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
      "Server primitives for databases, storage, queues, and workflows",
      "AI Agents defined in one file, with Channels for Slack, Discord, and Telegram",
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
    <LandingAgentStory />
    <LandingClosing />
  </UMain>
</template>
