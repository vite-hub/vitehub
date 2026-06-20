<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useHighlightedCode } from "../composables/useHighlightedCode";
import { defaultFramework, type Framework } from "~~/modules/vitehub-docs/runtime/utils/frameworks";
import { getShowcaseExamples, getShowcaseFiles, getShowcasePhasePaths, resolveShowcaseFramework, showcasePhaseIds, type ExampleFile, type ShowcasePhaseId } from "~~/modules/vitehub-docs/runtime/utils/showcase";

type TreeItem = { id: string; label: string; icon?: string; defaultExpanded?: boolean; children?: TreeItem[] };

const activeTab = ref(0);
const activeFilePath = ref("");
const activePhase = ref<ShowcasePhaseId>("run");
const activeProvider = ref("");
const selectionMemory = new Map<string, string>();
const docsPathByExample: Record<string, string> = {
  agent: "/docs/agents",
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

const hostPromises = [
  {
    title: "No vendor lock-in",
    icon: "i-lucide-route",
    text: "Keep application code on ViteHub Runtime Helpers while integrations emit the files, bindings, routes, and crons each provider expects.",
  },
  {
    title: "Open source forever",
    icon: "i-lucide-git-fork",
    text: "The framework stays inspectable, forkable, and portable instead of becoming a dashboard-only platform boundary.",
  },
  {
    title: "One server layer",
    icon: "i-lucide-boxes",
    text: "Compose agents, storage, queues, workflows, schedules, sandboxes, workspaces, sources, auth, env, and shell from the same Vite app.",
  },
];

const frameworkSteps = [
  {
    title: "Install the primitive packages",
    eyebrow: "01 / Packages",
    icon: "i-lucide-package-plus",
    code: "pnpm add @vite-hub/agent @vite-hub/workspace",
    text: "Add only the server primitives the app actually uses.",
  },
  {
    title: "Register Vite integrations",
    eyebrow: "02 / Vite Integration",
    icon: "i-lucide-plug-zap",
    code: "hubAgent(), hubWorkspace(), hubQueue()",
    text: "Let packages discover definitions and prepare generated runtime output.",
  },
  {
    title: "Declare definitions",
    eyebrow: "03 / Definitions",
    icon: "i-lucide-file-code-2",
    code: "server/agents/support/config.ts",
    text: "Use colocated files for agents, queues, workflows, schedules, sandboxes, and workspaces.",
  },
  {
    title: "Attach capabilities",
    eyebrow: "04 / Capabilities",
    icon: "i-lucide-blocks",
    code: "capabilities: [chat(), workspaceShell()]",
    text: "Give agents controlled abilities instead of handing raw tools to the model.",
  },
  {
    title: "Ground the runtime",
    eyebrow: "05 / Workspace",
    icon: "i-lucide-folder-tree",
    code: "workspace: { sources }",
    text: "Expose durable files, rules, and read-only Sources through one Workspace boundary.",
  },
  {
    title: "Select providers late",
    eyebrow: "06 / Provider Selection",
    icon: "i-lucide-switch-camera",
    code: "provider: 'cloudflare' | 'vercel'",
    text: "Keep host choices in Integration Options when they affect generated output.",
  },
  {
    title: "Call stable helpers",
    eyebrow: "07 / Runtime Helpers",
    icon: "i-lucide-terminal-square",
    code: "runAgent(), enqueue(), useWorkspace()",
    text: "Application routes use ViteHub imports instead of provider SDK plumbing.",
  },
  {
    title: "Inspect generated output",
    eyebrow: "08 / Provider Output",
    icon: "i-lucide-search-code",
    code: ".vercel/output/**, wrangler.json",
    text: "Generated files make the host boundary inspectable by humans and agents.",
  },
  {
    title: "Move without rewriting",
    eyebrow: "09 / Portability",
    icon: "i-lucide-unplug",
    code: "same Definition, different Provider Output",
    text: "ViteHub stays open source and keeps provider-specific code at the edge.",
  },
];

const examples = getShowcaseExamples().map(e => ({ ...e, icon: e.icon || "i-lucide-box", defaultPhase: e.defaultPhase || "configure", providers: e.providers || [] }));
const activeExample = computed(() => examples[activeTab.value]!);
const displayedFramework = computed<Framework>(() => {
  return resolveShowcaseFramework(activeExample.value, defaultFramework);
});
const activeDocsLink = computed(() => docsPathByExample[activeExample.value.docsPath] || docsPathByExample[activeExample.value.pkg] || "/docs");
const getStartedLink = computed(() => "/docs/getting-started/first-agent");
const activePhasePaths = computed(() => getShowcasePhasePaths(activeExample.value, displayedFramework.value));
const activeFiles = computed(() => getShowcaseFiles(activeExample.value, displayedFramework.value, activeProvider.value));
const activeFile = computed(() => activeFiles.value.find(f => f.path === activeFilePath.value) || activeFiles.value[0]);

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

onBeforeUnmount(() => {
  if (copiedTimeout) {
    clearTimeout(copiedTimeout);
  }
});
</script>

<template>
  <section class="relative overflow-hidden">
    <div class="landing-hero-gradient absolute inset-0 -z-5 pointer-events-none" />

    <div class="py-16 sm:py-20">
      <div class="mx-auto max-w-7xl px-6 lg:px-8">
        <div class="text-center">
          <p class="font-mono text-xs font-medium tracking-wide text-primary uppercase">Open source server primitives</p>
          <h1 class="mx-auto mt-4 max-w-[18ch] text-4xl font-semibold tracking-tight text-highlighted text-balance sm:text-5xl lg:text-6xl">
            Build once for any provider
          </h1>
          <p class="mx-auto mt-5 max-w-[55ch] text-lg text-muted text-pretty">
            ViteHub gives Vite apps stable Runtime Helpers, Agent Definitions, Workspaces, Sources, Capabilities, and server primitives while Vite Integrations generate the Provider Output each host needs.
          </p>
          <div class="relative z-10 mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <NuxtLink
              :to="getStartedLink"
              class="inline-flex items-center gap-2 rounded-md bg-primary py-2 pr-2 pl-3 text-sm font-medium text-inverted hover:bg-primary/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <span>Build first agent</span>
              <UIcon name="i-lucide-arrow-right" class="size-5 shrink-0" />
            </NuxtLink>
            <NuxtLink
              to="/docs/concepts/server-primitives-for-any-host"
              class="inline-flex items-center gap-2 rounded-md py-2 pr-3 pl-2 text-sm font-medium text-default hover:bg-elevated"
            >
              <UIcon name="i-lucide-server-cog" class="size-5 shrink-0" />
              <span>Read the host model</span>
            </NuxtLink>
          </div>
        </div>

        <dl class="mt-12 grid gap-px overflow-hidden rounded-sm border border-default bg-border text-left md:grid-cols-3">
          <div
            v-for="promise in hostPromises"
            :key="promise.title"
            class="bg-default p-5"
          >
            <dt class="flex items-start gap-3 text-lg font-semibold text-highlighted">
              <UIcon :name="promise.icon" class="size-5 shrink-0 text-primary" />
              <span class="min-w-0">{{ promise.title }}</span>
            </dt>
            <dd class="mt-3 text-base/7 text-muted text-pretty sm:text-sm/6">{{ promise.text }}</dd>
          </div>
        </dl>

        <div class="mt-24 grid gap-4 text-left lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)] lg:items-end">
          <div>
            <p class="font-mono text-xs font-medium tracking-wide text-muted uppercase">How it fits together</p>
            <h2 class="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-highlighted text-balance sm:text-4xl">
              Define the server layer once
            </h2>
          </div>
          <p class="max-w-[56ch] text-base/7 text-muted text-pretty lg:justify-self-end">
            The framework shape is simple: declare portable Definitions, call stable Runtime Helpers, and let Provider Output handle the host-specific edge.
          </p>
        </div>

        <dl class="mt-10 grid gap-px overflow-hidden rounded-sm border border-default bg-border text-left sm:grid-cols-2 xl:grid-cols-3">
          <div
            v-for="step in frameworkSteps"
            :key="step.title"
            class="bg-default p-4"
          >
            <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
              <UIcon :name="step.icon" class="size-4 shrink-0 text-muted" />
              <span class="max-w-full text-right font-mono text-xs leading-5 tabular-nums break-words text-muted">{{ step.eyebrow }}</span>
            </div>
            <dt class="text-base font-semibold text-highlighted">{{ step.title }}</dt>
            <dd class="mt-2 text-base/7 text-muted text-pretty sm:text-sm/6">{{ step.text }}</dd>
            <dd class="mt-4 border border-default bg-muted px-2 py-1.5 font-mono text-xs text-default">
              <code class="block truncate">{{ step.code }}</code>
            </dd>
          </div>
        </dl>

        <div class="mt-24 grid gap-4 text-left lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)] lg:items-end">
          <div>
            <p class="font-mono text-xs font-medium tracking-wide text-muted uppercase">Code proof</p>
            <h2 class="mt-3 max-w-[35ch] text-3xl font-semibold tracking-tight text-highlighted text-balance sm:text-4xl">
              The provider boundary stays at the end
            </h2>
          </div>
          <p class="max-w-[56ch] text-base/7 text-muted text-pretty lg:justify-self-end">
            Switch the primitive or provider below. The app-facing Definition stays readable; ViteHub changes the generated output and runtime wiring for the selected host.
          </p>
        </div>

        <div class="mx-auto mt-10 max-w-5xl">
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
                  :ui="{ link: '!rounded-none', linkTrailing: 'hidden', linkTrailingIcon: 'hidden' }"
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

            <div class="grid grid-cols-[1fr_auto] items-center border-t border-black/5 bg-muted/30 px-3 py-1.5 dark:border-white/5">
              <div v-if="activeExample.providers.length" class="flex items-center gap-2">
                <p class="text-[0.625rem] font-medium tracking-wider text-muted uppercase">Works with</p>
                <UTooltip v-for="provider in activeExample.providers" :key="provider.id" :text="provider.label">
                  <UButton
                    :icon="provider.icon" variant="ghost" size="xs" :padded="false"
                    class="provider-icon"
                    :class="[
                      provider.darkInvert && 'provider-icon-invert',
                      activeProvider === provider.id && 'provider-icon--active',
                    ]"
                    :aria-label="`Use ${provider.label}`"
                    :aria-pressed="activeProvider === provider.id"
                    @click="applyFrameworkSelection(displayedFramework, { provider: provider.id })"
                  />
                </UTooltip>
              </div>
              <NuxtLink :to="activeDocsLink" class="flex min-w-[7rem] shrink-0 items-center justify-end gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:text-primary/75">
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
