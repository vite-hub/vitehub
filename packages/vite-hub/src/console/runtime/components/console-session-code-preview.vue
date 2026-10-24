<script setup lang="ts">
import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import { computed, ref, watch } from "vue";
import { languageForPath } from "./console-session-code-language";

type LanguageModule = { default: LanguageRegistration[] };

const languageLoaders: Record<string, () => Promise<LanguageModule>> = {
  css: () => import("shiki/langs/css.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

let highlighter: Promise<HighlighterCore> | undefined;

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light-default.mjs"),
    import("shiki/themes/github-dark-default.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
    createHighlighterCore({ engine: createJavaScriptRegexEngine(), langs: [], themes: [light.default, dark.default] }),
  );
  return highlighter;
}

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
      const languageName = language.value;
      const loadLanguage = languageLoaders[languageName];
      if (!loadLanguage) throw new Error(`No syntax highlighter is registered for ${languageName}.`);
      const instance = await loadHighlighter();
      if (!instance.getLoadedLanguages().includes(languageName)) await instance.loadLanguage((await loadLanguage()).default);
      const rendered = instance.codeToHtml(content, {
        defaultColor: false,
        lang: languageName,
        themes: { dark: "github-dark-default", light: "github-light-default" },
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
