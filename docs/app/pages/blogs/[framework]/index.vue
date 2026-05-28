<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { computed } from "vue";
import { useDocsPage } from "../../../composables/useDocsPage";
import { getDocsPageFallback, resolveDocsRoute } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs-blog",
});

const route = useRoute();
const docsPath = computed(() => {
  const parts = route.path.split("/").filter(Boolean);
  return `/docs/${parts[1]}/tutorials`;
});
const routeState = resolveDocsRoute(docsPath.value);

if (!routeState) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { data: rawDoc } = await useAsyncData(
  `blogs:${routeState.sourcePath}`,
  () => queryCollection("docs").path(routeState.sourcePath).first(),
);

if (!routeState.page || !routeState.supported || !rawDoc.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(
  route.path,
  rawDoc,
  getDocsPageFallback(routeState.page),
);

const posts = computed(() => [
  {
    title: "Introducing ViteHub",
    description: "Server primitives for Vite and Nitro apps with good defaults, typed APIs, and provider choice.",
    image: "/images/tutorials/vitehub-intro-flat.png",
    badge: {
      label: "Overview",
      color: "primary" as const,
      variant: "soft" as const,
    },
    variant: "subtle" as const,
    to: `/blogs/${routeState.meta.framework}/introducing-vitehub`,
    ui: {
      root: "overflow-hidden",
      header: "aspect-[16/9]",
      body: "p-5 sm:p-6 lg:px-0",
      image: "object-cover object-center",
    },
  },
  {
    title: "Server primitives for any host",
    description: "Use storage, background work, workflows, schedules, sandbox execution, and workspace state without locking application code to one provider.",
    image: "/images/tutorials/server-primitives-flat.png",
    badge: {
      label: "Tutorial",
      color: "primary" as const,
      variant: "soft" as const,
    },
    variant: "subtle" as const,
    to: `/blogs/${routeState.meta.framework}/server-primitives-any-host`,
    ui: {
      root: "overflow-hidden",
      header: "aspect-[16/9]",
      body: "p-5 sm:p-6 lg:px-0",
      image: "object-cover object-center",
    },
  },
  {
    title: "Build an AI Agent in one file",
    description: "Build a support Agent with model behavior, Capabilities, Workspace Sources, DevTools, and an Agent Eval.",
    image: "/images/tutorials/agent-layers-flat.png",
    badge: {
      label: "Tutorial",
      color: "primary" as const,
      variant: "soft" as const,
    },
    variant: "subtle" as const,
    to: `/blogs/${routeState.meta.framework}/build-ai-chatbot`,
    ui: {
      root: "overflow-hidden",
      header: "aspect-[16/9]",
      body: "p-5 sm:p-6 lg:px-0",
      image: "object-cover object-center",
    },
  },
]);
</script>

<template>
  <UPage v-if="page" :ui="{ center: 'mx-auto max-w-5xl' }">
    <UPageHeader :title="page.title" :description="page.description" />

    <UPageBody class="blogs-content pb-24">
      <p class="my-5 max-w-3xl leading-7 text-muted text-pretty">
        These posts introduce ViteHub from the bottom up: the project direction, the server primitive layer, and the Agent layer.
      </p>

      <UBlogPosts orientation="vertical" class="mt-8 max-w-5xl pb-2">
        <UBlogPost
          v-for="post in posts"
          :key="post.to"
          v-bind="post"
          orientation="horizontal"
        />
      </UBlogPosts>
    </UPageBody>
  </UPage>
</template>
