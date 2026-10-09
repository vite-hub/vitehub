<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { useDocsPage } from "../../composables/useDocsPage";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsSectionForPath,
  isDocsLandingPath,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";
import {
  getDocsPageFallback,
  resolveDocsRoute,
} from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs",
});

const route = useRoute();
const routeState = resolveDocsRoute(route.path);

const { data: rawDoc } = await useAsyncData(`docs:${routeState.sourcePath}`, () =>
  queryCollection("docs").path(routeState.sourcePath).first(),
);

if (!routeState.page || !rawDoc.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(routeState.sourcePath, rawDoc, getDocsPageFallback(routeState.page));

const isReferencePage = computed(() => route.path.replace(/\/+$/, "") === "/docs/reference");
const isSupportMatrix = computed(
  () => route.path.replace(/\/+$/, "") === "/docs/frameworks-hosts/support-matrix",
);
// A product Overview is a landing page with a hero and page cards beside the shared navigation.
const landingSection = computed(() =>
  isDocsLandingPath(docsManifest.sections, route.path)
    ? getDocsSectionForPath(docsManifest.sections, route.path)
    : null,
);
const isTutorialPage = computed(
  () => routeState.page?.layout === "tutorial" || page.value?.layout === "tutorial",
);
</script>

<template>
  <SupportMatrix v-if="page && isSupportMatrix" />

  <DocsProductLanding v-else-if="page && landingSection" :page="page" :section="landingSection" />

  <!-- Remount numbered steps when navigating between tutorials. -->
  <DocsTutorial v-else-if="page && isTutorialPage" :key="page.path" :page="page" />

  <DocsArticle v-else-if="page" :page="page" :reference="isReferencePage" />
</template>
