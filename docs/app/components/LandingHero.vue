<script setup lang="ts">
import { useAppConfig } from "#imports";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useFramework } from "../composables/useFrameworkPreference";
import { useHighlightedCode } from "../composables/useHighlightedCode";
import { defaultFramework, frameworkColorIcons, frameworkLabels, type Framework } from "~~/modules/vitehub-docs/runtime/utils/frameworks";
import { getShowcaseExamples, getShowcaseFiles, getShowcasePhasePaths, showcasePhaseIds, type ExampleFile, type ShowcasePhaseId } from "~~/modules/vitehub-docs/runtime/utils/showcase";

type TreeItem = { id: string; label: string; icon?: string; defaultExpanded?: boolean; children?: TreeItem[] };

const { current, switchTo } = useFramework();
const activeTab = ref(0);
const activeFilePath = ref("");
const activePhase = ref<ShowcasePhaseId>("run");
const activeProvider = ref("");
const mounted = ref(false);
const selectionMemory = new Map<string, string>();

const examples = getShowcaseExamples().map(e => ({ ...e, icon: e.icon || "i-lucide-box", defaultPhase: e.defaultPhase || "configure", providers: e.providers || [] }));
const activeExample = computed(() => examples[activeTab.value]!);
const displayedFramework = computed<Framework>(() => mounted.value ? current.value : defaultFramework);
const getStartedLink = computed(() => `/docs/${displayedFramework.value}/getting-started/`);
const activeDocsLink = computed(() => `/docs/${displayedFramework.value}/${activeExample.value.docsPath}`);
const activePhasePaths = computed(() => getShowcasePhasePaths(activeExample.value, displayedFramework.value));
const activeFiles = computed(() => getShowcaseFiles(activeExample.value, displayedFramework.value, activeProvider.value));
const activeFile = computed(() => activeFiles.value.find(f => f.path === activeFilePath.value) || activeFiles.value[0]);

const fileIconMatchers = new Map<string, RegExp[]>([
  ["i-vscode-icons-file-type-nuxt", [/^nuxt\.config\.ts$/]],
  ["i-unjs-nitro", [/^nitro\.config\.ts$/]],
  ["i-vscode-icons-file-type-vite", [/^vite\.config\.ts$/]],
  ["i-vscode-icons-file-type-package", [/^package\.json$/]],
  ["i-vscode-icons-file-type-tsconfig-official", [/^tsconfig\.json$/, /^tsconfig\..+/]],
  ["i-vscode-icons-file-type-pnpm", [/^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/]],
  ["i-vscode-icons-file-type-npm", [/^package-lock\.json$/]],
  ["i-vscode-icons-file-type-dotenv", [/^env\.example$/, /^\.env$/, /^\.env\..+/]],
  ["i-vscode-icons-file-type-markdown", [/^readme\.md$/, /\.mdx?$/]],
  ["i-vscode-icons-file-type-typescript-official", [/\.tsx?$/]],
  ["i-vscode-icons-file-type-js-official", [/\.(?:[cm]?js|jsx)$/]],
  ["i-vscode-icons-file-type-vue", [/\.vue$/]],
  ["i-vscode-icons-file-type-json-official", [/\.json$/]],
  ["i-vscode-icons-file-type-yaml-official", [/\.ya?ml$/]],
  ["i-vscode-icons-file-type-toml", [/\.toml$/]],
  ["i-vscode-icons-file-type-html", [/\.html$/]],
]);

function getSelectionMemoryKey(examplePkg: string, framework: Framework, provider: string) {
  return `${examplePkg}:${framework}:${provider}`;
}

function getPhaseForPath(phasePaths: Partial<Record<ShowcasePhaseId, string>>, path: string) {
  return showcasePhaseIds.find(phaseId => phasePaths[phaseId] === path);
}

function resolvePreferredFilePath(
  framework: Framework,
  provider: string,
  phase: ShowcasePhaseId,
  files: ExampleFile[],
  phasePaths: Partial<Record<ShowcasePhaseId, string>>,
) {
  if (files.some(file => file.path === activeFilePath.value)) {
    return activeFilePath.value;
  }

  const currentPhase = getPhaseForPath(activePhasePaths.value, activeFilePath.value);
  const mappedPhasePath = currentPhase ? phasePaths[currentPhase] : undefined;
  if (mappedPhasePath && files.some(file => file.path === mappedPhasePath)) {
    return mappedPhasePath;
  }

  const rememberedPath = selectionMemory.get(getSelectionMemoryKey(activeExample.value.pkg, framework, provider));
  if (rememberedPath && files.some(file => file.path === rememberedPath)) {
    return rememberedPath;
  }

  return phasePaths[phase] || files[0]?.path || "";
}

function applyFrameworkSelection(framework: Framework, options: { phase?: ShowcasePhaseId; provider?: string } = {}) {
  const provider = options.provider && activeExample.value.providers.some(p => p.id === options.provider)
    ? options.provider
    : activeExample.value.providers[0]?.id || "";
  const phasePaths = getShowcasePhasePaths(activeExample.value, framework);
  const phase = options.phase && phasePaths[options.phase] ? options.phase : activeExample.value.defaultPhase;
  const files = getShowcaseFiles(activeExample.value, framework, provider);
  const nextFilePath = resolvePreferredFilePath(framework, provider, phase, files, phasePaths);

  activeProvider.value = provider;
  activePhase.value = getPhaseForPath(phasePaths, nextFilePath) || phase;
  activeFilePath.value = nextFilePath;
}

function resetSelection() {
  const phase = activePhasePaths.value[activePhase.value] ? activePhase.value : activeExample.value.defaultPhase;
  applyFrameworkSelection(displayedFramework.value, { phase, provider: activeProvider.value });
}

function onFrameworkSelect(framework: Framework) {
  applyFrameworkSelection(framework, { phase: "configure", provider: activeProvider.value });
  switchTo(framework);
}

watch([activeTab, displayedFramework], resetSelection, { immediate: true });

watch(
  () => [activeExample.value.pkg, displayedFramework.value, activeProvider.value, activeFilePath.value] as const,
  ([examplePkg, framework, provider, path]) => {
    if (path) {
      selectionMemory.set(getSelectionMemoryKey(examplePkg, framework, provider), path);
    }
  },
);

watch(activeFiles, () => {
  if (!activeFiles.value.some(f => f.path === activeFilePath.value))
    activeFilePath.value = activePhasePaths.value[activePhase.value] || activeFiles.value[0]?.path || "";
});

function fileIcon(path: string) {
  const fileName = path.split("/").pop()?.toLowerCase() || path.toLowerCase();
  for (const [icon, patterns] of fileIconMatchers) {
    if (patterns.some(pattern => pattern.test(fileName))) return icon;
  }

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
        icon: isFile ? fileIcon(pathSoFar) : "i-lucide-folder",
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
  const nextPhase = getPhaseForPath(activePhasePaths.value, item.id);
  if (nextPhase) activePhase.value = nextPhase;
}

function treeItemIcon(item: TreeItem, expanded: boolean) {
  const isFile = activeFiles.value.some(file => file.path === item.id || file.path === item.label || file.path.endsWith(`/${item.label}`));
  if (!isFile) {
    return expanded ? "i-lucide-folder-open" : "i-lucide-folder";
  }

  return fileIcon(item.id || item.label);
}

const frameworkOptions = (["vite", "nitro", "nuxt"] as const).map(id => ({ id, label: frameworkLabels[id], icon: frameworkColorIcons[id] }));
const copyIcons = { copy: "i-lucide-copy", copyCheck: "i-lucide-check" };
const copied = ref(false);
let copiedTimeout: ReturnType<typeof setTimeout> | undefined;

const { data: highlightedCode } = useHighlightedCode(
  () => activeFile.value?.path || "hero",
  () => activeFile.value?.code || "",
);

async function copyActiveFile() {
  if (!activeFile.value?.code || typeof navigator === "undefined") {
    return;
  }

  await navigator.clipboard.writeText(activeFile.value.code);
  copied.value = true;
  if (copiedTimeout) {
    clearTimeout(copiedTimeout);
  }
  copiedTimeout = setTimeout(() => {
    copied.value = false;
  }, 2000);
}

onMounted(() => {
  mounted.value = true;
});

onBeforeUnmount(() => {
  if (copiedTimeout) {
    clearTimeout(copiedTimeout);
  }
});
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
            <NuxtLink
              :to="getStartedLink"
              class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-primary/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <span>Get started</span>
              <UIcon name="i-lucide-arrow-right" class="size-5 shrink-0" />
            </NuxtLink>
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

        <div class="mx-auto mt-20 max-w-5xl">
          <div class="terminal-chrome overflow-hidden rounded-xl border border-black/10 dark:border-white/10 dark:shadow-none">
            <div class="flex items-center gap-3 border-b border-black/5 bg-muted/50 px-4 py-2.5 dark:border-white/5">
              <div class="flex items-center gap-1.5">
                <span class="size-3 rounded-full bg-[#ff5f56]/80" />
                <span class="size-3 rounded-full bg-[#ffbd2e]/80" />
                <span class="size-3 rounded-full bg-[#27c93f]/80" />
              </div>
              <p class="mx-auto text-xs font-medium text-muted">ViteHub {{ activeExample.label }}</p>
              <div class="w-12" />
            </div>

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

            <div class="flex bg-default">
              <div class="hidden w-52 shrink-0 border-r border-black/5 bg-muted/30 py-2 md:block dark:border-white/5">
                <UTree
                  class="landing-file-tree"
                  :items="fileTree"
                  :model-value="activeTreeItem"
                  :expanded="treeExpanded"
                  :get-key="getTreeItemKey"
                  size="xs"
                  :ui="{ linkTrailing: 'hidden', linkTrailingIcon: 'hidden' }"
                  @select="onTreeSelect"
                >
                  <template #item-leading="{ item, expanded }">
                    <UIcon
                      :name="treeItemIcon(item, expanded)"
                      class="size-3.5 shrink-0"
                    />
                  </template>
                </UTree>
              </div>

              <div class="relative min-h-80 min-w-0 flex-1">
                <div class="flex items-center gap-2 border-b border-black/5 px-3 py-2 dark:border-white/5">
                  <UIcon :name="fileIcon(activeFile?.path || '')" class="size-3.5 shrink-0 text-muted" />
                  <p class="min-w-0 truncate text-xs font-medium text-default">{{ (activeFile?.path.split('/').pop() || '').replace('env.example', '.env') }}</p>
                  <UButton
                    :icon="copied ? copyIcons.copyCheck : copyIcons.copy"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    aria-label="Copy code"
                    class="ml-auto shrink-0"
                    tabindex="-1"
                    @click="copyActiveFile"
                  />
                </div>
                <div v-if="activeFile" class="landing-code-block hero-code-block">
                  <div class="code-block-wrapper">
                    <div v-if="highlightedCode" v-html="highlightedCode" />
                    <pre v-else class="p-4 font-mono text-sm text-muted"><code>{{ activeFile.code }}</code></pre>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid grid-cols-[auto_1fr_auto] items-center border-t border-black/5 bg-muted/30 px-3 py-1.5 dark:border-white/5">
              <div class="flex items-center gap-0.5 rounded-lg ring ring-black/5 p-0.5 dark:ring-white/10">
                <UButton
                  v-for="fw in frameworkOptions" :key="fw.id"
                  :icon="fw.icon" :label="fw.label"
                  :color="displayedFramework === fw.id ? 'primary' : 'neutral'"
                  :variant="displayedFramework === fw.id ? 'soft' : 'ghost'"
                  size="xs"
                  :aria-pressed="displayedFramework === fw.id"
                  @click="onFrameworkSelect(fw.id)"
                />
              </div>
              <div class="flex items-center justify-self-center gap-2">
                <p class="text-[0.625rem] font-medium tracking-wider text-muted uppercase">Works with</p>
                <UTooltip v-for="provider in activeExample.providers" :key="provider.id" :text="provider.label">
                  <UButton
                    :icon="provider.icon" variant="ghost" size="xs" :padded="false"
                    class="provider-icon transition-all"
                    :class="[
                      provider.darkInvert && 'provider-icon-invert',
                      activeProvider === provider.id && 'provider-icon--active',
                    ]"
                    :aria-pressed="activeProvider === provider.id"
                    @click="applyFrameworkSelection(displayedFramework, { provider: provider.id })"
                  />
                </UTooltip>
              </div>
              <NuxtLink :to="activeDocsLink" class="flex min-w-[7rem] shrink-0 items-center justify-end gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:text-primary/75">
                Read docs
                <UIcon name="i-lucide-arrow-right" class="size-3" />
              </NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
