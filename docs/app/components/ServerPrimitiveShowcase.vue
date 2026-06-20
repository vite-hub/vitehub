<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useHighlightedCode } from "../composables/useHighlightedCode";
import { defaultFramework, type Framework } from "~~/modules/vitehub-docs/runtime/utils/frameworks";
import {
  getShowcaseExamples,
  getShowcaseFiles,
  getShowcasePhasePaths,
  resolveShowcaseFramework,
  showcasePhaseIds,
  type ExampleFile,
  type ShowcasePhaseId,
} from "~~/modules/vitehub-docs/runtime/utils/showcase";

type TreeItem = { id: string; label: string; icon?: string; defaultExpanded?: boolean; children?: TreeItem[] };

const docsPathByExample: Record<string, string> = {
  blob: "/docs/server-primitives/blob",
  db: "/docs/server-primitives/database",
  env: "/docs/server-primitives/env",
  kv: "/docs/server-primitives/kv",
  queue: "/docs/server-primitives/queue",
  sandbox: "/docs/server-primitives/sandbox",
  schedule: "/docs/server-primitives/schedule",
  workflow: "/docs/server-primitives/workflows",
  workspace: "/docs/server-primitives/workspace",
};

const docsActionByExample: Record<string, string> = {
  blob: "Store Blob files",
  db: "Configure Database",
  env: "Configure Env",
  kv: "Configure KV Store",
  queue: "Define a Queue",
  sandbox: "Run Sandbox work",
  schedule: "Define a Schedule",
  workflow: "Define a Workflow",
  workspace: "Define a Workspace",
};

const examples = getShowcaseExamples().map(example => ({
  ...example,
  icon: example.icon || "i-lucide-box",
  defaultPhase: example.defaultPhase || "configure",
  providers: example.providers || [],
}));

const initialExampleIndex = Math.max(0, examples.findIndex(example => example.pkg === "kv"));
const activeTab = ref(initialExampleIndex);
const activeFilePath = ref("");
const activePhase = ref<ShowcasePhaseId>("run");
const activeProvider = ref("");
const selectionMemory = new Map<string, string>();
const copiedCode = ref(false);
let copiedCodeTimeout: ReturnType<typeof setTimeout> | undefined;

const activeExample = computed(() => examples[activeTab.value] || examples[0]!);
const displayedFramework = computed<Framework>(() => resolveShowcaseFramework(activeExample.value, defaultFramework));
const activeDocsLink = computed(() => docsPathByExample[activeExample.value.docsPath] || docsPathByExample[activeExample.value.pkg] || "/docs/server-primitives");
const activeDocsAction = computed(() => docsActionByExample[activeExample.value.docsPath] || docsActionByExample[activeExample.value.pkg] || "Open primitive guide");
const activePhasePaths = computed(() => getShowcasePhasePaths(activeExample.value, displayedFramework.value));
const activeFiles = computed(() => getShowcaseFiles(activeExample.value, displayedFramework.value, activeProvider.value));
const activeFile = computed(() => activeFiles.value.find(file => file.path === activeFilePath.value) || activeFiles.value[0]);

const fileIconMatchers = new Map<string, RegExp[]>([
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
  const provider = options.provider && activeExample.value.providers.some(item => item.id === options.provider)
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
  if (!activeFiles.value.some(file => file.path === activeFilePath.value)) {
    activeFilePath.value = activePhasePaths.value[activePhase.value] || activeFiles.value[0]?.path || "";
  }
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

    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      pathSoFar += (pathSoFar ? "/" : "") + name;
      const isFile = index === parts.length - 1;
      const displayName = name === "env.example" ? ".env" : name;
      const existing = level.find(item => item.label === displayName);

      if (existing && !isFile) {
        level = existing.children!;
        continue;
      }

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
      if (item.children) {
        keys.push(item.id);
        walk(item.children);
      }
    }
  }

  walk(fileTree.value);
  return keys;
});

function onTreeSelect(_event: Event, item: { id: string }) {
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

async function copyText(value: string) {
  let didCopy = false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      didCopy = true;
    }
  } catch {}

  if (!didCopy && typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    didCopy = document.execCommand("copy");
    textarea.remove();
  }

  return didCopy;
}

async function copyActiveFile() {
  if (!activeFile.value?.code || !(await copyText(activeFile.value.code))) return;

  copiedCode.value = true;
  if (copiedCodeTimeout) clearTimeout(copiedCodeTimeout);
  copiedCodeTimeout = setTimeout(() => {
    copiedCode.value = false;
  }, 2000);
}

const { data: highlightedCode } = useHighlightedCode(
  () => activeFile.value?.path || "server-primitive-showcase",
  () => activeFile.value?.code || "",
);

onBeforeUnmount(() => {
  if (copiedCodeTimeout) clearTimeout(copiedCodeTimeout);
});
</script>

<template>
  <section class="not-prose my-8">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <p class="max-w-[62ch] text-base/7 text-muted text-pretty sm:text-sm/6">
        Switch the primitive or provider to inspect the Definition files, Runtime Helper calls, and Provider Output that ViteHub keeps behind stable app-facing imports.
      </p>
      <NuxtLink :to="activeDocsLink" class="inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-base font-medium text-primary hover:text-primary/75 sm:text-sm">
        {{ activeDocsAction }}
        <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0 sm:size-3.5" aria-hidden="true" />
      </NuxtLink>
    </div>

    <div class="overflow-hidden rounded-sm border border-default bg-default">
      <div class="flex items-center gap-3 border-b border-default bg-muted/50 px-4 py-2.5">
        <div class="flex items-center gap-1.5" aria-hidden="true">
          <span class="size-3 rounded-full bg-muted" />
          <span class="size-3 rounded-full bg-muted" />
          <span class="size-3 rounded-full bg-highlighted" />
        </div>
        <p class="mx-auto truncate text-xs font-medium text-muted">ViteHub {{ activeExample.label }}</p>
        <div class="w-12" />
      </div>

      <div role="tablist" class="flex overflow-x-auto border-b border-default bg-default hide-scrollbar">
        <UButton
          v-for="(example, index) in examples"
          :key="example.pkg"
          :icon="example.icon"
          :label="example.label"
          :color="activeTab === index ? 'primary' : 'neutral'"
          :variant="activeTab === index ? 'soft' : 'ghost'"
          size="xs"
          role="tab"
          :aria-selected="activeTab === index"
          class="relative shrink-0 rounded-none border-r border-default px-4 py-2.5"
          :class="activeTab === index && 'after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary'"
          @click="activeTab = index"
        />
      </div>

      <div class="flex bg-default">
        <div class="hidden w-52 shrink-0 border-r border-default bg-muted/30 py-2 md:block">
          <UTree
            class="landing-file-tree"
            :items="fileTree"
            :model-value="activeTreeItem"
            :expanded="treeExpanded"
            :get-key="getTreeItemKey"
            size="xs"
            :ui="{ link: '!rounded-none', linkTrailing: 'hidden', linkTrailingIcon: 'hidden' }"
            @select="onTreeSelect"
          >
            <template #item-leading="{ item, expanded }">
              <UIcon :name="treeItemIcon(item, expanded)" class="size-3.5 shrink-0" />
            </template>
          </UTree>
        </div>

        <div class="relative min-h-80 min-w-0 flex-1">
          <div class="flex items-center gap-2 border-b border-default px-3 py-2">
            <UIcon :name="fileIcon(activeFile?.path || '')" class="size-3.5 shrink-0 text-muted" />
            <p class="min-w-0 truncate text-xs font-medium text-default">{{ (activeFile?.path.split('/').pop() || '').replace('env.example', '.env') }}</p>
            <UButton
              :icon="copiedCode ? 'i-lucide-check' : 'i-lucide-copy'"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Copy code"
              class="ml-auto shrink-0"
              tabindex="-1"
              @click="copyActiveFile"
            />
          </div>
          <div v-if="activeFile" class="max-h-[28rem] overflow-auto bg-muted/20">
            <div class="code-block-wrapper">
              <div v-if="highlightedCode" v-html="highlightedCode" />
              <pre v-else class="p-4 font-mono text-sm text-muted"><code>{{ activeFile.code }}</code></pre>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-[1fr_auto] items-center border-t border-default bg-muted/30 px-3 py-1.5">
        <div v-if="activeExample.providers.length" class="flex min-w-0 items-center gap-2">
          <p class="shrink-0 text-xs font-medium text-muted">Works with</p>
          <UTooltip v-for="provider in activeExample.providers" :key="provider.id" :text="provider.label">
            <UButton
              :icon="provider.icon"
              variant="ghost"
              size="xs"
              :aria-label="`Use ${provider.label}`"
              :aria-pressed="activeProvider === provider.id"
              :class="activeProvider === provider.id && 'text-primary ring-1 ring-primary/30'"
              @click="applyFrameworkSelection(displayedFramework, { provider: provider.id })"
            />
          </UTooltip>
        </div>
        <NuxtLink :to="activeDocsLink" class="flex min-w-[7rem] shrink-0 items-center justify-end gap-1 rounded-sm px-2 py-0.5 text-xs font-medium text-primary hover:text-primary/75 sm:hidden">
          {{ activeDocsAction }}
          <UIcon name="i-lucide-arrow-right" class="size-3 shrink-0" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
