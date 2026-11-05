<script setup lang="ts">
import PrimitiveLanding from "~/components/PrimitiveLanding.vue";
import { getPrimitiveLanding } from "~/data/primitive-landings";

// Primitive landings such as `/kv` and the docs pages outside `/docs`, such as `/about`, share one path segment.
const route = useRoute();
const landing = getPrimitiveLanding(String(route.params.slug));
</script>

<template>
  <PrimitiveLanding v-if="landing" :landing="landing" />
  <DocsPage v-else />
</template>
