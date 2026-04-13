<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useFrameworkPreference as useFramework } from "../../composables/useFrameworkPreference";
import { useHighlightedCode } from "../../composables/useHighlightedCode";
import { frameworkColorIcons, frameworkLabels, type Framework } from "../../utils/frameworks";
import { getShowcaseExamples, getShowcasePhasePaths, getShowcaseFiles, type ExampleFile, type ShowcasePhaseId } from "../../utils/showcase";

type TreeItem = { id: string; label: string; icon?: string; defaultExpanded?: boolean; children?: TreeItem[] };

const { current, switchTo } = useFramework();
const activeTab = ref(0);
const activeFilePath = ref("");
const activePhase = ref<ShowcasePhaseId>("run");
const activeProvider = ref("");

const examples = getShowcaseExamples().map(e => ({ ...e, icon: e.icon || "i-lucide-box", defaultPhase: e.defaultPhase || "configure", providers: e.providers || [] }));
const activeExample = computed(() => examples[activeTab.value]!);
const activeDocsLink = computed(() => `/docs/${current.value}/${activeExample.value.docsPath}`);
const activePhasePaths = computed(() => getShowcasePhasePaths(activeExample.value, current.value));
const activeFiles = computed(() => getShowcaseFiles(activeExample.value, current.value, activeProvider.value));
const activeFile = computed(() => activeFiles.value.find(f => f.path === activeFilePath.value) || activeFiles.value[0]);

function applyFrameworkSelection(framework: Framework, options: { phase?: ShowcasePhaseId; provider?: string } = {}) {
  const provider = options.provider && activeExample.value.providers.some(p => p.id === options.provider)
    ? options.provider
    : activeExample.value.providers[0]?.id || "";
  const phasePaths = getShowcasePhasePaths(activeExample.value, framework);
  const phase = options.phase && phasePaths[options.phase] ? options.phase : activeExample.value.defaultPhase;
  const files = getShowcaseFiles(activeExample.value, framework, provider);
  activeProvider.value = provider;
  activePhase.value = phase;
  activeFilePath.value = phasePaths[phase] || files[0]?.path || "";
}

function resetSelection() {
  const phase = activePhasePaths.value[activePhase.value] ? activePhase.value : activeExample.value.defaultPhase;
  applyFrameworkSelection(current.value, { phase, provider: activeProvider.value });
}

function onFrameworkSelect(framework: Framework) {
  applyFrameworkSelection(framework, { phase: "configure", provider: activeProvider.value });
  switchTo(framework);
}

watch([activeTab, current], resetSelection, { immediate: true });

watch(activeFiles, () => {
  if (!activeFiles.value.some(f => f.path === activeFilePath.value))
    activeFilePath.value = activePhasePaths.value[activePhase.value] || activeFiles.value[0]?.path || "";
});

function fileIcon(path: string) {
  if (path.endsWith(".json")) return "i-lucide-file-json";
  if (path === "env.example") return "i-lucide-file-key";
  return "i-lucide-file-code";
}

function buildFileTree(files: ExampleFile[]): TreeItem[] {
  const root: TreeItem[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let level = root;
    let pathSoFar = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      pathSoFar += (pathSoFar ? "/" : "") + name;
      const isFile = i === parts.length - 1;
      const displayName = name === "env.example" ? ".env" : name;
      const existing = level.find(n => n.label === displayName);
      if (existing && !isFile) { level = existing.children!; continue; }
      const node: TreeItem = {
        id: pathSoFar,
        label: displayName,
        icon: isFile ? fileIcon(name) : "i-lucide-folder",
        defaultExpanded: !isFile,
        ...(!isFile && { children: [] }),
      };
      level.push(node);
      if (!isFile) level = node.children!;
    }
  }
  return root;
}

const fileTree = computed(() => buildFileTree(activeFiles.value));

function findTreeItemById(items: TreeItem[], id: string): TreeItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findTreeItemById(item.children, id);
      if (found) return found;
    }
  }
}

const activeTreeItem = computed(() => findTreeItemById(fileTree.value, activeFilePath.value));
const getTreeItemKey = (item: TreeItem) => item.id;

const treeExpanded = computed(() => {
  const keys: string[] = [];
  function walk(items: TreeItem[]) {
    for (const item of items) {
      if (item.children) { keys.push(item.id); walk(item.children); }
    }
  }
  walk(fileTree.value);
  return keys;
});

function onTreeSelect(_e: Event, item: { id: string }) {
  activeFilePath.value = item.id;
  const nextPhase = (["configure", "define", "run"] as ShowcasePhaseId[]).find(p => activePhasePaths.value[p] === item.id);
  if (nextPhase) activePhase.value = nextPhase;
}

const frameworkOptions = (["vite", "nitro", "nuxt"] as const).map(id => ({ id, label: frameworkLabels[id], icon: frameworkColorIcons[id] }));
const activeProviderEntry = computed(() => activeExample.value.providers.find(p => p.id === activeProvider.value));

const { data: highlightedCode } = useHighlightedCode(
  () => activeFile.value?.path || "hero",
  () => activeFile.value?.code || "",
);
</script>

<template>
  <section class="relative overflow-hidden">
    <div class="landing-hero-gradient absolute inset-0 -z-5 pointer-events-none" />

    <div class="py-24 sm:py-32">
      <div class="mx-auto max-w-7xl px-6 lg:px-8">
        <div class="mx-auto text-center">
          <h1 class="mx-auto max-w-[24ch] text-5xl font-semibold tracking-tight text-highlighted text-balance sm:text-6xl lg:text-7xl">
            Server primitives for <span class="text-primary">every host</span>
          </h1>
          <p class="mx-auto mt-6 max-w-[48ch] text-lg text-muted text-pretty">
            One API surface across every provider and framework.
          </p>
          <div class="relative z-10 mt-10 flex items-center justify-center gap-4">
            <a
              :href="`/docs/${current}/getting-started/`"
              class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-primary/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <span>Get started</span>
              <UIcon name="i-lucide-arrow-right" class="size-5 shrink-0" />
            </a>
            <a
              href="https://github.com/vite-hub/vitehub"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-default transition-colors hover:bg-elevated"
            >
              <UIcon name="i-simple-icons-github" class="size-5 shrink-0" />
              <span>GitHub</span>
            </a>
          </div>
        </div>

        <!-- Terminal showcase -->
        <div class="mx-auto mt-20 max-w-5xl">
          <div class="terminal-chrome overflow-hidden rounded-xl border border-black/10 dark:border-white/10 dark:shadow-none">
            <!-- Title bar -->
            <div class="flex items-center gap-3 border-b border-black/5 bg-muted/50 px-4 py-2.5 dark:border-white/5">
              <div class="flex items-center gap-1.5">
                <span class="size-3 rounded-full bg-[#ff5f56]/80" />
                <span class="size-3 rounded-full bg-[#ffbd2e]/80" />
                <span class="size-3 rounded-full bg-[#27c93f]/80" />
              </div>
              <p class="mx-auto text-xs font-medium text-muted">ViteHub {{ activeExample.label }}</p>
              <div class="w-12" />
            </div>

            <!-- Tab bar -->
            <div role="tablist" class="flex overflow-x-auto border-b border-black/5 bg-default dark:border-white/5 hide-scrollbar">
              <UButton
                v-for="(example, index) in examples" :key="example.pkg"
                :icon="example.icon" :label="example.label"
                :color="activeTab === index ? 'primary' : 'neutral'"
                :variant="activeTab === index ? 'soft' : 'ghost'"
                size="xs" role="tab" :aria-selected="activeTab === index"
                class="relative shrink-0 rounded-none border-r border-black/5 px-4 py-2.5 dark:border-white/5"
                :class="activeTab === index && 'after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary'"
                @click="activeTab = index"
              />
            </div>

            <!-- File tree + code -->
            <div class="flex bg-default">
              <!-- File tree sidebar -->
              <div class="hidden w-52 shrink-0 border-r border-black/5 bg-muted/30 py-2 md:block dark:border-white/5">
                <UTree
                  :items="fileTree"
                  :model-value="activeTreeItem"
                  :expanded="treeExpanded"
                  :get-key="getTreeItemKey"
                  size="xs"
                  @select="onTreeSelect"
                />
              </div>

              <!-- Code panel -->
              <div class="relative min-h-80 min-w-0 flex-1">
                <div class="flex items-center gap-2 border-b border-black/5 px-3 py-2 dark:border-white/5">
                  <UIcon :name="fileIcon(activeFile?.path || '')" class="size-3.5 shrink-0 text-muted" />
                  <p class="text-xs font-medium text-default">{{ (activeFile?.path.split('/').pop() || '').replace('env.example', '.env') }}</p>
                </div>
                <div v-if="activeFile" class="landing-code-block hero-code-block">
                  <div class="code-block-wrapper">
                    <div v-if="highlightedCode" v-html="highlightedCode" />
                    <pre v-else class="p-4 font-mono text-sm text-muted"><code>{{ activeFile.code }}</code></pre>
                  </div>
                </div>
              </div>
            </div>

            <!-- Status bar -->
            <div class="flex items-center border-t border-black/5 bg-muted/30 px-3 py-1.5 dark:border-white/5">
              <div class="flex items-center gap-0.5 rounded-lg ring ring-black/5 p-0.5 dark:ring-white/10">
                <UButton
                  v-for="fw in frameworkOptions" :key="fw.id"
                  :icon="fw.icon" :label="fw.label"
                  :color="current === fw.id ? 'primary' : 'neutral'"
                  :variant="current === fw.id ? 'soft' : 'ghost'"
                  size="xs" @click="onFrameworkSelect(fw.id as Framework)"
                />
              </div>
              <div class="mx-auto flex items-center gap-2">
                <p class="text-[0.625rem] font-medium tracking-wider text-muted uppercase">Works with</p>
                <UTooltip v-for="provider in activeExample.providers" :key="provider.id" :text="provider.label">
                  <UButton
                    :icon="provider.icon" variant="ghost" size="xs" :padded="false"
                    class="provider-icon transition-all"
                    :class="provider.darkInvert && 'provider-icon-invert'"
                    @click="activeProvider = provider.id"
                  />
                </UTooltip>
              </div>
              <NuxtLink :to="activeDocsLink" class="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:text-primary/75">
                {{ activeProviderEntry?.label || activeExample.label }} docs
                <UIcon name="i-lucide-arrow-right" class="size-3" />
              </NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
