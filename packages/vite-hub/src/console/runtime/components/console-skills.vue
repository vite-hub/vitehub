<script setup lang="ts">
import * as v from "valibot";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import { consoleSkillFileSchema, consoleSkillsSchema, type ConsoleSkillFile, type ConsoleSkills } from "../skills";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSkillTree from "./console-skill-tree.vue";
import ConsoleSkillFilePreview from "./console-skill-file.vue";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
  skillsBase: string;
}>();
const route = useRoute();
const router = useRouter();
const catalog = shallowRef<ConsoleSkills>();
const file = shallowRef<ConsoleSkillFile>();
const loading = ref(false);
const fileLoading = ref(false);
const error = ref("");
const fileError = ref("");
let catalogRequest: AbortController | undefined;
let fileRequest: AbortController | undefined;
const agent = computed(() => v.is(v.string(), route.query.agent) ? route.query.agent : undefined);
const path = computed(() => v.is(v.string(), route.query.path) ? route.query.path : undefined);
const paths = computed(() => catalog.value?.files.map(file => file.path) ?? []);
const skillCount = computed(() => paths.value.filter(path => /(?:^|\/)SKILL\.md$/.test(path)).length);
const selectedAgent = computed(() => agent.value ?? catalog.value?.agent);
function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Try again.";
}
async function selectAgent(value: string) {
  await router.push({ query: { ...route.query, agent: value, path: undefined } });
}
async function selectFile(value: string) {
  if (path.value === value) return;
  await router.push({ query: { ...route.query, agent: selectedAgent.value, path: value } });
}
async function loadFile() {
  fileRequest?.abort();
  file.value = undefined;
  fileError.value = "";
  fileLoading.value = false;
  if (!path.value || !selectedAgent.value) return;
  const controller = new AbortController();
  fileRequest = controller;
  fileLoading.value = true;
  try {
    const result = v.parse(consoleSkillFileSchema, await requestConsole(props.skillsBase, {
      query: { agent: selectedAgent.value, path: path.value }, signal: controller.signal,
    }));
    if (!controller.signal.aborted) file.value = result;
  } catch (cause) {
    if (!controller.signal.aborted) fileError.value = message(cause);
  } finally {
    if (fileRequest === controller) fileLoading.value = false;
  }
}
async function loadCatalog() {
  catalogRequest?.abort();
  fileRequest?.abort();
  const controller = new AbortController();
  catalogRequest = controller;
  loading.value = true;
  catalog.value = undefined;
  file.value = undefined;
  error.value = "";
  try {
    const result = v.parse(consoleSkillsSchema, await requestConsole(props.skillsBase, {
      query: { agent: agent.value }, signal: controller.signal,
    }));
    if (controller.signal.aborted) return;
    catalog.value = result;
    if (!path.value) {
      const first = result.files.find(file => /(?:^|\/)SKILL\.md$/.test(file.path)) ?? result.files[0];
      if (first) {
        await router.replace({ query: { ...route.query, agent: result.agent, path: first.path } });
        return;
      }
    }
    await loadFile();
  } catch (cause) {
    if (!controller.signal.aborted) error.value = message(cause);
  } finally {
    if (catalogRequest === controller) loading.value = false;
  }
}
watch([agent, path], ([nextAgent], [previousAgent]) => {
  if (!catalog.value || nextAgent !== previousAgent) void loadCatalog();
  else void loadFile();
}, { immediate: true });
onMounted(() => rememberConsoleSection("skills"));
onBeforeUnmount(() => { catalogRequest?.abort(); fileRequest?.abort(); });
</script>

<template>
  <ConsoleFrame active="skills" :sections-base="sectionsBase">
    <ConsoleSearch :agents-base="agentsBase" :definitions-base="definitionsBase" :kv-base="kvBase" :search-base="searchBase" :sections-base="sectionsBase" />
    <UDashboardPanel id="skills" :ui="{ body: 'min-h-0 overflow-hidden p-0 sm:p-0 gap-0 sm:gap-0' }">
      <template #header>
        <ConsolePageHeader title="Skills" :toggle="false">
          <template #right>
            <UButton label="Skill index" to="https://vitehub.dev/.well-known/skills/index.json" target="_blank" rel="noopener noreferrer" icon="i-ph-arrow-up-right-light" :ui="{ label: 'hidden sm:inline' }" size="xs" color="neutral" variant="ghost" aria-label="Open ViteHub's published Skill index" />
            <USelect v-if="catalog?.agents.length" :model-value="selectedAgent" :items="catalog.agents" aria-label="Agent" class="w-28 sm:w-44" size="sm" variant="ghost" @update:model-value="selectAgent" />
            <UButton aria-label="Refresh Skills" icon="i-ph-arrows-clockwise-light" size="xs" color="neutral" variant="ghost" :disabled="loading" @click="loadCatalog" />
          </template>
        </ConsolePageHeader>
      </template>
      <template #body>
        <p v-if="loading" role="status" class="p-4 text-sm text-muted">Loading Skills…</p>
        <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-3 p-4 text-sm">
          <span>{{ error }}</span><UButton label="Try again" color="neutral" variant="ghost" @click="loadCatalog" />
        </div>
        <div v-else-if="!paths.length" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <UIcon name="i-ph-books-light" class="size-7 text-muted" />
          <h1 class="text-balance text-base font-medium text-highlighted">No bundled Skills{{ selectedAgent ? ` for ${selectedAgent}` : '' }}</h1>
          <p class="max-w-md text-pretty text-sm text-muted">Add a skills folder beside the Agent Definition. Its SKILL.md files and supporting files will appear here.</p>
          <UButton label="Skills guide" to="https://vitehub.dev/docs/agents/capabilities/skills" target="_blank" color="neutral" variant="ghost" icon="i-ph-arrow-up-right-light" />
        </div>
        <main v-else class="skills-browser">
          <aside class="skills-browser__tree flex min-h-0 min-w-0 flex-col" aria-label="Bundled Skill files">
            <header class="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-default px-3 text-xs sm:px-4">
              <span class="font-medium text-highlighted">Files</span>
              <span class="tabular-nums text-muted">{{ skillCount }} {{ skillCount === 1 ? 'skill' : 'skills' }} · {{ paths.length }} files</span>
            </header>
            <div class="min-h-0 flex-1 overflow-hidden">
              <ConsoleSkillTree :key="selectedAgent" :paths="paths" :selected="path" @select="selectFile" />
            </div>
            <p class="border-t border-default px-3 py-2 text-pretty text-xs leading-relaxed text-muted sm:px-4">Bundled with this Agent. Source-mounted Skills are available in the session Workspace.</p>
          </aside>
          <div class="flex min-h-0 min-w-0 flex-col" :aria-busy="fileLoading">
            <p v-if="fileLoading" role="status" class="p-4 text-sm text-muted">Loading file…</p>
            <div v-else-if="fileError" role="alert" class="flex flex-wrap items-center gap-3 p-4 text-sm">
              <span>{{ fileError }}</span><UButton label="Try again" color="neutral" variant="ghost" @click="loadFile" />
            </div>
            <ConsoleSkillFilePreview v-else-if="file" :key="file.path" :file="file" :paths="paths" />
            <p v-else class="p-4 text-sm text-muted">Select a file to preview it.</p>
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style scoped>
.skills-browser { display: grid; grid-template-columns: minmax(14rem, 19rem) minmax(0, 1fr); flex: 1; min-height: 0; }
.skills-browser__tree { border-inline-end: 1px solid var(--ui-border); }
@media (width < 640px) {
  .skills-browser { grid-template-columns: minmax(0, 1fr); grid-template-rows: 12rem minmax(0, 1fr); }
  .skills-browser__tree { border-inline-end: 0; border-bottom: 1px solid var(--ui-border); }
  .skills-browser__tree > p { display: none; }
}
</style>
