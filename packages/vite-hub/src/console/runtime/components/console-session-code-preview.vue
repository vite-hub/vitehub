<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { languageForPath } from "./console-session-code-language";

const props = defineProps<{ content: string; path: string; wrap?: boolean }>();
const html = ref("");
const loading = ref(false);
const highlightingFailed = ref(false);
let renderId = 0;

const language = computed(() => languageForPath(props.path));
const plainLines = computed(() => props.content.split("\n"));

watch(
  () => [props.content, props.path] as const,
  async ([content]) => {
    const id = ++renderId;
    loading.value = true;
    html.value = "";
    highlightingFailed.value = false;
    try {
      const { codeToHtml } = await import("shiki/bundle/web");
      const rendered = await codeToHtml(content, {
        defaultColor: false,
        lang: language.value,
        themes: { dark: "github-dark", light: "github-light" },
      });
      if (id === renderId) html.value = rendered;
    } catch (error) {
      console.error("[vitehub] Workspace syntax highlighting failed.", error);
      if (id === renderId) highlightingFailed.value = true;
    } finally {
      if (id === renderId) loading.value = false;
    }
  },
  { immediate: true },
);

</script>

<template>
  <div class="session-code-preview" :data-wrap="wrap">
    <div v-if="loading && !html" class="session-inspector__state">
      <UIcon name="i-lucide-loader-circle" class="animate-spin" />Highlighting file…
    </div>
    <pre v-else-if="highlightingFailed" class="session-code-preview__plain"><code><span
      v-for="(line, index) in plainLines"
      :key="index"
      class="line"
    ><span>{{ line || "\u200b" }}</span></span></code></pre>
    <div v-else class="session-code-preview__html" v-html="html" />
  </div>
</template>
