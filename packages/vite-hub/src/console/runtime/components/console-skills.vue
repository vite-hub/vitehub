<script setup lang="ts">
import * as v from "valibot";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ConsoleRequestError, requestConsole } from "../client/request";
import { rememberConsoleSection } from "../sections";
import { consoleSkillFileSchema, consoleSkillsSchema, type ConsoleSkillFile, type ConsoleSkills } from "../skills";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";
import ConsoleSkillTree from "./console-skill-tree.vue";
import ConsoleSkillFilePreview from "./console-skill-file.vue";

const skillFile = /(?:^|\/)SKILL\.md$/;
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
/** The Agents of the last catalog, so the selector stays while another Agent loads. */
const agents = shallowRef<string[]>([]);
const file = shallowRef<ConsoleSkillFile>();
const loading = ref(true);
const fileLoading = ref(false);
const failed = ref<unknown>();
const fileFailed = ref<unknown>();
let catalogRequest: AbortController | undefined;
let fileRequest: AbortController | undefined;
const agent = computed(() => v.is(v.string(), route.query.agent) ? route.query.agent : undefined);
const path = computed(() => v.is(v.string(), route.query.path) ? route.query.path : undefined);
const paths = computed(() => catalog.value?.files.map(file => file.path) ?? []);
const skillCount = computed(() => paths.value.filter(path => skillFile.test(path)).length);
const selectedAgent = computed(() => agent.value ?? catalog.value?.agent);
/** A binary or oversized file has no text preview, and a retry cannot change that. */
const noPreview = computed(() =>
  fileFailed.value instanceof ConsoleRequestError && (fileFailed.value.status === 413 || fileFailed.value.status === 415)
    ? fileFailed.value.message
    : undefined,
);
/** An Agent from an old link can be gone. Without its catalog there is no selector, so offer the default Agent. */
const failedActions = computed(() =>
  agent.value && failed.value instanceof ConsoleRequestError && failed.value.status === 404
    ? [{ label: "Open the default Agent", onClick: () => void router.replace({ query: {} }) }]
    : undefined,
);
function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
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
  fileFailed.value = undefined;
  fileLoading.value = false;
  // A refresh keeps the open file until the new content arrives.
  if (file.value?.path !== path.value) file.value = undefined;
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
    if (controller.signal.aborted) return;
    file.value = undefined;
    fileFailed.value = cause;
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
  failed.value = undefined;
  // Another Agent has other files. A refresh of the same Agent keeps its tree until the new catalog arrives.
  if (agent.value !== catalog.value?.agent) {
    catalog.value = undefined;
    file.value = undefined;
  }
  try {
    const result = v.parse(consoleSkillsSchema, await requestConsole(props.skillsBase, {
      query: { agent: agent.value }, signal: controller.signal,
    }));
    if (controller.signal.aborted) return;
    catalog.value = result;
    agents.value = result.agents;
    // The URL names the Agent and the file, so links, Back, and Refresh keep this catalog.
    const selected = path.value ?? (result.files.find(file => skillFile.test(file.path)) ?? result.files[0])?.path;
    if (agent.value !== result.agent || path.value !== selected) {
      // The watcher opens the file. The URL then names the Agent of this catalog, so the catalog does not load again.
      await router.replace({ query: { ...route.query, agent: result.agent, path: selected } });
      return;
    }
    void loadFile();
  } catch (cause) {
    if (!controller.signal.aborted) failed.value = cause;
  } finally {
    if (catalogRequest === controller) loading.value = false;
  }
}
watch([agent, path], ([nextAgent]) => {
  if (!catalog.value || nextAgent !== catalog.value.agent) void loadCatalog();
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
            <UButton label="Skill index" to="https://vitehub.dev/.well-known/skills/index.json" target="_blank" rel="noopener noreferrer" icon="i-ph-arrow-up-right-light" :ui="{ label: 'hidden sm:inline' }" size="sm" color="neutral" variant="ghost" aria-label="Open ViteHub's published Skill index" />
            <USelect v-if="agents.length" :model-value="selectedAgent" :items="agents" aria-label="Agent" class="w-28 sm:w-44" size="sm" @update:model-value="selectAgent" />
            <UTooltip text="Refresh Skills">
              <UButton aria-label="Refresh Skills" color="neutral" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :disabled="loading" @click="loadCatalog" />
            </UTooltip>
          </template>
        </ConsolePageHeader>
      </template>
      <template #body>
        <ConsoleState v-if="failed" :error="failed" title="Could not load Skills" :retry="loadCatalog" :actions="failedActions" />
        <div v-else-if="loading && !catalog" class="skills-browser" aria-busy="true">
          <div class="skills-browser__tree grid content-start gap-2.5 p-3 sm:p-4">
            <USkeleton class="mb-1.5 h-8 w-full animate-none" />
            <USkeleton v-for="index in 7" :key="index" class="h-4 animate-none" :class="index % 3 ? 'w-3/4' : 'w-1/2'" />
          </div>
          <div class="hidden content-start gap-3 px-10 py-7 sm:grid">
            <USkeleton class="mb-2 h-6 w-1/3 animate-none" />
            <USkeleton v-for="index in 6" :key="index" class="h-4 animate-none" :class="index % 3 === 0 ? 'w-2/3' : 'w-full'" />
          </div>
        </div>
        <ConsoleState
          v-else-if="!paths.length"
          section="skills"
          icon="i-ph-books-light"
          :title="selectedAgent ? `No bundled Skills for ${selectedAgent}` : 'No bundled Skills'"
          description="Add a skills folder beside the Agent Definition. Its SKILL.md files and supporting files appear here."
        />
        <main v-else class="skills-browser">
          <aside class="skills-browser__tree flex min-h-0 min-w-0 flex-col" aria-label="Bundled Skill files">
            <header class="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-default px-3 text-xs sm:px-4">
              <span class="font-medium text-highlighted">Files</span>
              <span class="tabular-nums text-muted">{{ plural(skillCount, "skill") }} · {{ plural(paths.length, "file") }}</span>
            </header>
            <div class="min-h-0 flex-1 overflow-hidden">
              <ConsoleSkillTree :key="selectedAgent" :paths="paths" :selected="path" @select="selectFile" />
            </div>
            <p class="border-t border-default px-3 py-2 text-pretty text-xs leading-relaxed text-muted sm:px-4">Bundled with this Agent. Source-mounted Skills are available in the session Workspace.</p>
          </aside>
          <div class="flex min-h-0 min-w-0 flex-col" :aria-busy="fileLoading">
            <ConsoleState v-if="noPreview" icon="i-ph-file-dashed-light" title="No preview for this file" :description="noPreview" />
            <ConsoleState v-else-if="fileFailed" :error="fileFailed" title="Could not open this file" :retry="loadFile" />
            <ConsoleSkillFilePreview v-else-if="file" :key="file.path" :file="file" :paths="paths" />
            <div v-else-if="fileLoading" class="mx-auto grid w-full max-w-[75ch] content-start gap-3 px-4 py-7 sm:px-10">
              <USkeleton class="mb-2 h-6 w-1/3 animate-none" />
              <USkeleton v-for="index in 6" :key="index" class="h-4 animate-none" :class="index % 3 === 0 ? 'w-2/3' : 'w-full'" />
            </div>
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
