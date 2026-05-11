<script setup lang="ts">
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { navigateTo, useRoute } from "#app/composables/router";
import { resolveDocsRoute } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs-blog",
});

const route = useRoute();
const routeState = resolveDocsRoute(route.path);

if (!routeState) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

await navigateTo(`/blogs/${routeState.meta.framework}`, { redirectCode: 301 });
</script>
