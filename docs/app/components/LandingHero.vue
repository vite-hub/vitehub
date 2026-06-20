<script setup lang="ts">
import { useReducedMotion, type Options } from "motion-v";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
type MotionTransition = NonNullable<Options["transition"]>;

const pluginCode = `import { vitehub } from "@vite-hub/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vitehub(),
  ],
});`;

const installAudiences = [
  { label: "For humans", value: "humans", icon: "i-lucide-user" },
  { label: "For agents", value: "agents", icon: "i-lucide-bot" },
] as const;

const packageManagers = [
  {
    label: "pnpm",
    value: "pnpm",
    icon: "i-simple-icons-pnpm",
    command: "pnpm add @vite-hub/vite",
  },
  {
    label: "npm",
    value: "npm",
    icon: "i-simple-icons-npm",
    command: "npm install @vite-hub/vite",
  },
  {
    label: "bun",
    value: "bun",
    icon: "i-simple-icons-bun",
    command: "bun add @vite-hub/vite",
  },
  {
    label: "yarn",
    value: "yarn",
    icon: "i-simple-icons-yarn",
    command: "yarn add @vite-hub/vite",
  },
] as const;

const platformSignalGroups = [
  {
    label: "Vite frameworks",
    signals: [
      { label: "Vite", icon: "i-simple-icons-vite", color: "" },
      { label: "Nuxt", icon: "i-simple-icons-nuxt", color: "" },
      { label: "Nitro", icon: "i-ph-plug-light", color: "" },
      { label: "Astro", icon: "i-simple-icons-astro", color: "" },
      { label: "SvelteKit", icon: "i-simple-icons-svelte", color: "" },
      { label: "TanStack Start", icon: "i-simple-icons-tanstack", color: "" },
      { label: "React Router", icon: "i-lucide-route", color: "" },
      { label: "SolidStart", icon: "i-simple-icons-solid", color: "" },
      { label: "Qwik City", icon: "i-simple-icons-qwik", color: "" },
      { label: "Any Vite framework", icon: "i-lucide-blocks", color: "" },
    ],
  },
  {
    label: "Host targets",
    signals: [
      { label: "Cloudflare", icon: "i-simple-icons-cloudflare", color: "" },
      { label: "Vercel", icon: "i-simple-icons-vercel", color: "" },
      { label: "Netlify", icon: "i-simple-icons-netlify", color: "" },
      { label: "Node/self-hosted", icon: "i-simple-icons-nodedotjs", color: "" },
      { label: "Any host", icon: "i-lucide-server", color: "" },
    ],
  },
] as const;

const platformSignalSummaries = platformSignalGroups.map(group => ({
  label: group.label,
  text: group.signals.map(signal => signal.label).join(", "),
}));

const heroAgentCoreNodes = [
  {
    label: "Channels",
    icon: "i-lucide-radio",
    angle: 0,
    summary: "One Agent Definition can be reached from product and platform surfaces.",
    stat: "",
    tokens: [
      { label: "Slack", icon: "i-simple-icons-slack" },
      { label: "GitHub PR", icon: "i-simple-icons-github" },
      { label: "Telegram", icon: "i-simple-icons-telegram" },
      { label: "Discord", icon: "i-simple-icons-discord" },
      { label: "Web chat", icon: "i-lucide-message-square" },
      { label: "HTTP", icon: "i-lucide-webhook" },
    ],
  },
  {
    label: "Capabilities",
    icon: "i-lucide-blocks",
    angle: 90,
    summary: "Attach named abilities only when the active Agent Driver should receive them.",
    stat: "27 documented abilities",
    tokens: [
      { label: "Shell", icon: "i-lucide-terminal" },
      { label: "Search", icon: "i-lucide-search" },
      { label: "MCP", icon: "i-lucide-plug" },
      { label: "DB", icon: "i-lucide-database" },
      { label: "KV", icon: "i-lucide-key-round" },
      { label: "Blob", icon: "i-lucide-hard-drive" },
      { label: "Sandbox", icon: "i-lucide-box" },
    ],
  },
  {
    label: "Driver",
    icon: "i-lucide-cpu",
    angle: 180,
    summary: "The engine boundary for model execution, streaming, usage, and lifecycle.",
    stat: "",
    tokens: [
      { label: "AI SDK", icon: "i-simple-icons-vercel" },
      { label: "OpenAI", icon: "i-simple-icons-openai" },
      { label: "Streams", icon: "i-lucide-radio-tower" },
      { label: "Usage", icon: "i-lucide-gauge" },
    ],
  },
  {
    label: "Workspace",
    icon: "i-lucide-folder-tree",
    angle: 270,
    summary: "A Linux-like file tree with explicit Sources, so the model uses your context.",
    stat: "",
    tokens: [
      { label: "Linux", icon: "i-simple-icons-linux" },
      { label: "Sources", icon: "i-lucide-file-search" },
      { label: "Docs", icon: "i-lucide-files" },
      { label: "GitHub", icon: "i-simple-icons-github" },
    ],
  },
] as const;

const heroProviderNodes = [
  { label: "Cloudflare", icon: "i-simple-icons-cloudflare", angle: 20 },
  { label: "Vercel", icon: "i-simple-icons-vercel", angle: 80 },
  { label: "Netlify", icon: "i-simple-icons-netlify", angle: 140 },
  { label: "Node", icon: "i-simple-icons-nodedotjs", angle: 200 },
  { label: "AWS", icon: "i-simple-icons-amazonwebservices", angle: 260 },
  { label: "Fly.io", icon: "i-simple-icons-flydotio", angle: 320 },
] as const;

const heroAgentRecipes = [
  {
    channel: "GitHub",
    channelIcon: "i-simple-icons-github",
    workspace: "PR",
    workspaceIcon: "i-lucide-git-pull-request",
    capability: "MCP browser",
    capabilityIcon: "i-lucide-plug",
    agent: "Review Agent",
  },
  {
    channel: "Slack",
    channelIcon: "i-simple-icons-slack",
    workspace: "Wiki",
    workspaceIcon: "i-lucide-book-open",
    capability: "Search",
    capabilityIcon: "i-lucide-search",
    agent: "Support Agent",
  },
  {
    channel: "Telegram",
    channelIcon: "i-simple-icons-telegram",
    workspace: "Voice notes",
    workspaceIcon: "i-lucide-audio-lines",
    capability: "Transcribe",
    capabilityIcon: "i-lucide-file-audio",
    agent: "Field Agent",
  },
  {
    channel: "Web chat",
    channelIcon: "i-lucide-message-square",
    workspace: "Docs",
    workspaceIcon: "i-lucide-files",
    capability: "DB + KV",
    capabilityIcon: "i-lucide-database",
    agent: "Onboarding Agent",
  },
  {
    channel: "HTTP",
    channelIcon: "i-lucide-webhook",
    workspace: "API Source",
    workspaceIcon: "i-lucide-cloud",
    capability: "Sandbox",
    capabilityIcon: "i-lucide-box",
    agent: "Ops Agent",
  },
  {
    channel: "Discord",
    channelIcon: "i-simple-icons-discord",
    workspace: "Community",
    workspaceIcon: "i-lucide-library",
    capability: "Rate limit",
    capabilityIcon: "i-lucide-gauge",
    agent: "Community Agent",
  },
] as const;

type InstallAudience = (typeof installAudiences)[number]["value"];
type PackageManager = (typeof packageManagers)[number]["value"];

const activeInstallAudience = ref<InstallAudience>("humans");
const activePackageManager = ref<PackageManager>("pnpm");
const copiedInstall = ref(false);
let copiedInstallTimeout: ReturnType<typeof setTimeout> | undefined;

const activeTab = ref(0);
const activeFilePath = ref("");
const activePhase = ref<ShowcasePhaseId>("run");
const activeProvider = ref("");
const selectionMemory = new Map<string, string>();
const copiedCode = ref(false);
let copiedCodeTimeout: ReturnType<typeof setTimeout> | undefined;

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

const capabilitySteps = [
  {
    icon: "i-lucide-bot",
    title: "Define the server actor.",
    text: "Start with the Agent Driver. It decides how one Agent Invocation runs before any tool, storage, channel, or execution surface is exposed.",
  },
  {
    icon: "i-lucide-folder-tree",
    title: "Ground it in a scoped file tree.",
    text: "Add Workspace context when answers need project files, docs, or source-backed facts. Sources stay read-only until a Capability exposes tools.",
  },
  {
    icon: "i-lucide-radio",
    title: "Let any trusted surface invoke it.",
    text: "Add Channels for reachability after the Agent exists. GitHub, web chat, streams, and app routes can reach the same Agent Definition.",
  },
  {
    icon: "i-lucide-blocks",
    title: "Expose only the abilities needed.",
    text: "Attach Capabilities only when the active Agent Driver should receive a named ability such as Workspace inspection, search, storage, or commands.",
  },
  {
    icon: "i-lucide-terminal-square",
    title: "Keep execution explicit.",
    text: "Expose isolated command execution last, with executable names allowlisted at the Capability boundary.",
  },
] as const;

type CapabilityDiffLineKind = "context" | "add" | "remove";
type CapabilityDiffLine = {
  kind: CapabilityDiffLineKind;
  oldLine?: string;
  newLine?: string;
  text: string;
};

const capabilityDiffs: { label: string; lines: CapabilityDiffLine[] }[] = [
  {
    label: "Agent Definition",
    lines: [
      { kind: "add", newLine: "1", text: "import { defineAgent } from '@vite-hub/vite/agent'" },
      { kind: "context", newLine: "2", text: "" },
      { kind: "add", newLine: "3", text: "export default defineAgent({" },
      { kind: "add", newLine: "4", text: "  driver: {" },
      { kind: "add", newLine: "5", text: "    run: async () => {" },
      { kind: "add", newLine: "6", text: "      return 'Support agent ready.'" },
      { kind: "add", newLine: "7", text: "    }," },
      { kind: "add", newLine: "8", text: "  }," },
      { kind: "add", newLine: "9", text: "})" },
    ],
  },
  {
    label: "Workspace and Sources",
    lines: [
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/vite/agent'" },
      { kind: "context", oldLine: "2", newLine: "2", text: "" },
      { kind: "context", oldLine: "3", newLine: "3", text: "export default defineAgent({" },
      { kind: "context", oldLine: "4", newLine: "4", text: "  driver: {" },
      { kind: "context", oldLine: "5", newLine: "5", text: "    run: async () => {" },
      { kind: "context", oldLine: "6", newLine: "6", text: "      return 'Support agent ready.'" },
      { kind: "context", oldLine: "7", newLine: "7", text: "    }," },
      { kind: "context", oldLine: "8", newLine: "8", text: "  }," },
      { kind: "add", newLine: "9", text: "  workspace: {" },
      { kind: "add", newLine: "10", text: "    sources: {" },
      { kind: "add", newLine: "11", text: "      docs: {" },
      { kind: "add", newLine: "12", text: "        include: ['README.md', 'docs/**/*.md']," },
      { kind: "add", newLine: "13", text: "      }," },
      { kind: "add", newLine: "14", text: "    }," },
      { kind: "add", newLine: "15", text: "  }," },
      { kind: "context", oldLine: "9", newLine: "16", text: "})" },
    ],
  },
  {
    label: "Channels and Invocation",
    lines: [
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/vite/agent'" },
      { kind: "add", newLine: "2", text: "import {" },
      { kind: "add", newLine: "3", text: "  github," },
      { kind: "add", newLine: "4", text: "  stream," },
      { kind: "add", newLine: "5", text: "  webChat," },
      { kind: "add", newLine: "6", text: "} from '@vite-hub/vite/agent/channels'" },
      { kind: "context", oldLine: "2", newLine: "7", text: "" },
      { kind: "context", oldLine: "3", newLine: "8", text: "export default defineAgent({" },
      { kind: "context", oldLine: "4", newLine: "9", text: "  driver: {" },
      { kind: "context", oldLine: "5", newLine: "10", text: "    run: async () => {" },
      { kind: "context", oldLine: "6", newLine: "11", text: "      return 'Support agent ready.'" },
      { kind: "context", oldLine: "7", newLine: "12", text: "    }," },
      { kind: "context", oldLine: "8", newLine: "13", text: "  }," },
      { kind: "add", newLine: "14", text: "  channels: {" },
      { kind: "add", newLine: "15", text: "    github: github()," },
      { kind: "add", newLine: "16", text: "    web: webChat()," },
      { kind: "add", newLine: "17", text: "    portal: stream()," },
      { kind: "add", newLine: "18", text: "  }," },
      { kind: "context", oldLine: "9", newLine: "19", text: "})" },
    ],
  },
  {
    label: "Capabilities",
    lines: [
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/vite/agent'" },
      { kind: "add", newLine: "2", text: "import {" },
      { kind: "add", newLine: "3", text: "  workspaceShell," },
      { kind: "add", newLine: "4", text: "} from '@vite-hub/vite/agent/capabilities'" },
      { kind: "context", oldLine: "2", newLine: "5", text: "" },
      { kind: "context", oldLine: "3", newLine: "6", text: "export default defineAgent({" },
      { kind: "context", oldLine: "4", newLine: "7", text: "  driver: {" },
      { kind: "context", oldLine: "5", newLine: "8", text: "    run: async () => {" },
      { kind: "context", oldLine: "6", newLine: "9", text: "      return 'Support agent ready.'" },
      { kind: "context", oldLine: "7", newLine: "10", text: "    }," },
      { kind: "context", oldLine: "8", newLine: "11", text: "  }," },
      { kind: "add", newLine: "12", text: "  capabilities: [" },
      { kind: "add", newLine: "13", text: "    workspaceShell({ mode: 'read' })," },
      { kind: "add", newLine: "14", text: "  ]," },
      { kind: "context", oldLine: "9", newLine: "15", text: "})" },
    ],
  },
  {
    label: "Sandbox",
    lines: [
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/vite/agent'" },
      { kind: "remove", oldLine: "2", text: "import { workspaceShell } from '@vite-hub/vite/agent/capabilities'" },
      { kind: "add", newLine: "2", text: "import {" },
      { kind: "add", newLine: "3", text: "  sandbox," },
      { kind: "add", newLine: "4", text: "  workspaceShell," },
      { kind: "add", newLine: "5", text: "} from '@vite-hub/vite/agent/capabilities'" },
      { kind: "context", oldLine: "3", newLine: "6", text: "" },
      { kind: "context", oldLine: "4", newLine: "7", text: "export default defineAgent({" },
      { kind: "context", oldLine: "5", newLine: "8", text: "  driver: {" },
      { kind: "context", oldLine: "6", newLine: "9", text: "    run: async () => {" },
      { kind: "context", oldLine: "7", newLine: "10", text: "      return 'Support agent ready.'" },
      { kind: "context", oldLine: "8", newLine: "11", text: "    }," },
      { kind: "context", oldLine: "9", newLine: "12", text: "  }," },
      { kind: "context", oldLine: "10", newLine: "13", text: "  capabilities: [" },
      { kind: "context", oldLine: "11", newLine: "14", text: "    workspaceShell({ mode: 'read' })," },
      { kind: "add", newLine: "15", text: "    sandbox({" },
      { kind: "add", newLine: "16", text: "      commands: ['node', 'pnpm']," },
      { kind: "add", newLine: "17", text: "    })," },
      { kind: "context", oldLine: "12", newLine: "18", text: "  ]," },
      { kind: "context", oldLine: "13", newLine: "19", text: "})" },
    ],
  },
];

const activeCapabilityStep = ref(0);
const firstCapabilityDiff = capabilityDiffs[0]!;
const activeCapabilityDiff = computed(() => capabilityDiffs[activeCapabilityStep.value] ?? firstCapabilityDiff);
const prefersReducedMotion = useReducedMotion();
const capabilityMotionEase: [number, number, number, number] = [0.23, 1, 0.32, 1];
const capabilityStepTransition = computed<MotionTransition>(() =>
  prefersReducedMotion.value
    ? { duration: 0 }
    : { duration: 0.32, ease: capabilityMotionEase },
);
const capabilityCodeCardTransition = computed<MotionTransition>(() =>
  prefersReducedMotion.value
    ? { duration: 0 }
    : { duration: 0.42, ease: capabilityMotionEase },
);
const capabilityStepElements: HTMLElement[] = [];
let capabilityStepObserver: IntersectionObserver | undefined;
let capabilityStepSyncFrame: number | undefined;
let capabilityStepSyncTimeout: ReturnType<typeof setTimeout> | undefined;

function setCapabilityStepElement(element: unknown, index: number) {
  if (element instanceof HTMLElement) {
    capabilityStepElements[index] = element;
  }
}

function getCapabilityStepMotion(index: number) {
  const isActive = activeCapabilityStep.value === index;

  if (prefersReducedMotion.value) {
    return { opacity: isActive ? 1 : 0.38, y: 0, scale: 1 };
  }

  return {
    opacity: isActive ? 1 : 0.34,
    y: 0,
    scale: 1,
  };
}

function syncCapabilityStepFromViewport() {
  const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-capability-step]"));
  const targetY = window.innerHeight * 0.42;
  let closestIndex = activeCapabilityStep.value;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const element of elements) {
    const index = Number(element.dataset.capabilityStep);
    if (!Number.isInteger(index)) continue;

    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const distance = Math.abs(rect.top + Math.min(rect.height * 0.35, 160) - targetY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }

  activeCapabilityStep.value = closestIndex;
}

function scheduleCapabilityStepSync() {
  if (capabilityStepSyncFrame !== undefined) return;

  capabilityStepSyncFrame = window.requestAnimationFrame(() => {
    capabilityStepSyncFrame = undefined;
    syncCapabilityStepFromViewport();
  });
}

onMounted(() => {
  if (typeof window.IntersectionObserver === "function") {
    capabilityStepObserver = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter(entry => entry.isIntersecting)
          .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];

        const nextIndex = Number(visibleEntry?.target.getAttribute("data-capability-step"));
        if (Number.isInteger(nextIndex)) {
          activeCapabilityStep.value = nextIndex;
        }
      },
      {
        rootMargin: "-32% 0px -42% 0px",
        threshold: [0.2, 0.45, 0.7, 0.95],
      },
    );

    for (const element of capabilityStepElements) {
      capabilityStepObserver.observe(element);
    }
  }

  window.addEventListener("scroll", scheduleCapabilityStepSync, { passive: true });
  scheduleCapabilityStepSync();
  capabilityStepSyncTimeout = setTimeout(scheduleCapabilityStepSync, 500);
});

const selectedPackageManager = computed(
  () => packageManagers.find(manager => manager.value === activePackageManager.value) ?? packageManagers[0],
);
const agentInstallCommand = "npx skills add https://vitehub.dev";
const activeInstallText = computed(() =>
  activeInstallAudience.value === "humans" ? selectedPackageManager.value.command : agentInstallCommand,
);
const installCopyLabel = computed(() =>
  copiedInstall.value
    ? activeInstallAudience.value === "humans"
      ? "Copied install command"
      : "Copied agent skill command"
    : activeInstallAudience.value === "humans"
      ? "Copy install command"
      : "Copy agent skill command",
);

const examples = getShowcaseExamples().map(example => ({
  ...example,
  icon: example.icon || "i-lucide-box",
  defaultPhase: example.defaultPhase || "configure",
  providers: example.providers || [],
}));
const activeExample = computed(() => examples[activeTab.value]!);
const displayedFramework = computed<Framework>(() => resolveShowcaseFramework(activeExample.value, defaultFramework));
const activeDocsLink = computed(() => docsPathByExample[activeExample.value.docsPath] || docsPathByExample[activeExample.value.pkg] || "/docs");
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

watch([activeInstallAudience, activePackageManager], () => {
  copiedInstall.value = false;
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

async function copyInstallText() {
  if (!(await copyText(activeInstallText.value))) return;

  copiedInstall.value = true;
  if (copiedInstallTimeout) clearTimeout(copiedInstallTimeout);
  copiedInstallTimeout = setTimeout(() => {
    copiedInstall.value = false;
  }, 1500);
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
  () => activeFile.value?.path || "hero",
  () => activeFile.value?.code || "",
);
const { data: highlightedPluginCode } = useHighlightedCode("vite.config.ts", pluginCode);
const activeCapabilityCode = computed(() => activeCapabilityDiff.value.lines.map(line => line.text).join("\n"));
const { data: highlightedCapabilityCode } = useHighlightedCode(
  () => `support-agent-${activeCapabilityStep.value}.ts`,
  () => activeCapabilityCode.value,
  "ts",
);
const highlightedCapabilityLines = computed(() => {
  const code = highlightedCapabilityCode.value?.match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1];
  return code?.split("\n") || [];
});

function highlightedCapabilityLine(index: number) {
  return highlightedCapabilityLines.value[index] || "&nbsp;";
}

onBeforeUnmount(() => {
  capabilityStepObserver?.disconnect();
  window.removeEventListener("scroll", scheduleCapabilityStepSync);
  if (capabilityStepSyncFrame !== undefined) window.cancelAnimationFrame(capabilityStepSyncFrame);
  if (capabilityStepSyncTimeout) clearTimeout(capabilityStepSyncTimeout);
  if (copiedInstallTimeout) clearTimeout(copiedInstallTimeout);
  if (copiedCodeTimeout) clearTimeout(copiedCodeTimeout);
});
</script>

<template>
  <section class="vh-ground-grid relative isolate overflow-hidden bg-default">
    <div class="mx-auto max-w-7xl px-4 pt-12 pb-10 sm:px-6 sm:pt-20 sm:pb-16 lg:px-8 lg:pt-24">
      <div class="grid gap-10 lg:grid-cols-[minmax(0,18fr)_minmax(0,22fr)] lg:items-center">
        <div class="min-w-0">
          <h1 class="max-w-[15ch] text-5xl font-semibold text-highlighted text-balance sm:text-6xl lg:text-7xl">
            Agents for any host.
          </h1>
          <p class="mt-6 max-w-[50ch] text-lg/8 text-muted text-pretty">
            Compose them with server primitives for databases, storage, workflows, schedules, and workspaces through one Vite plugin.
          </p>

          <div class="mt-8 flex w-full max-w-2xl flex-col items-stretch gap-3">
            <div
              class="flex w-full flex-wrap items-center justify-between gap-3"
            >
              <div
                class="relative inline-grid grid-cols-2 gap-1 rounded-sm bg-muted/70 p-1 text-sm ring-1 ring-default"
                role="tablist"
                aria-label="Install audience"
              >
                <span
                  class="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%_-_0.75rem)/2)] rounded-sm bg-default ring-1 ring-default transition-transform duration-[400ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
                  :style="{ transform: activeInstallAudience === 'agents' ? 'translateX(calc(100% + 0.25rem))' : 'translateX(0)' }"
                  aria-hidden="true"
                />
                <button
                  v-for="audience in installAudiences"
                  :key="audience.value"
                  type="button"
                  role="tab"
                  :aria-selected="activeInstallAudience === audience.value"
                  class="relative z-10 inline-flex min-w-32 items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 font-medium transition-[color,transform] duration-150 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  :class="activeInstallAudience === audience.value ? 'text-highlighted' : 'text-muted hover:text-default'"
                  @click="activeInstallAudience = audience.value"
                >
                  <UIcon :name="audience.icon" class="size-3.5 shrink-0" aria-hidden="true" />
                  <span>{{ audience.label }}</span>
                </button>
              </div>

              <div
                class="relative h-10 w-full shrink-0 sm:ml-auto sm:w-[13rem]"
                role="radiogroup"
                aria-label="Package manager"
                :aria-hidden="activeInstallAudience !== 'humans'"
              >
                <div
                  class="absolute top-0 left-0 flex items-center gap-1 rounded-sm bg-muted/70 p-1 text-sm ring-1 ring-default transition-[opacity,transform,filter] duration-[260ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none sm:right-0 sm:left-auto"
                  :class="
                    activeInstallAudience === 'humans'
                      ? 'translate-y-0 opacity-100'
                      : 'pointer-events-none translate-y-1 opacity-0 blur-[1px]'
                  "
                  :aria-hidden="activeInstallAudience !== 'humans'"
                >
                  <button
                    v-for="manager in packageManagers"
                    :key="manager.value"
                    type="button"
                    role="radio"
                    :tabindex="activeInstallAudience === 'humans' ? 0 : -1"
                    :aria-checked="activePackageManager === manager.value"
                    :aria-label="manager.label"
                    class="inline-flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-sm font-medium transition-[width,color,transform,background-color,box-shadow] duration-[220ms] ease-out active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none"
                    :class="
                      activePackageManager === manager.value
                        ? 'w-[5.5rem] bg-default px-2.5 text-highlighted ring-1 ring-default'
                        : 'w-8 px-0 text-muted grayscale hover:text-default'
                    "
                    @click="activePackageManager = manager.value"
                  >
                    <UIcon :name="manager.icon" class="size-3.5 shrink-0" aria-hidden="true" />
                    <span
                      class="overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin-left] duration-[180ms] ease-out motion-reduce:transition-none"
                      :class="activePackageManager === manager.value ? 'ml-1.5 max-w-12 opacity-100' : 'ml-0 max-w-0 opacity-0'"
                    >
                      {{ manager.label }}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <button
              type="button"
              class="group inline-flex w-full max-w-2xl items-center gap-1.5 rounded-sm bg-default px-2.5 py-1.5 text-left ring-1 ring-default transition-[box-shadow,background-color] duration-200 hover:bg-default hover:ring-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              :aria-label="installCopyLabel"
              @click="copyInstallText"
            >
              <span class="font-mono text-base text-dimmed select-none" aria-hidden="true">$</span>
              <span class="relative block min-w-0 flex-1 overflow-hidden font-mono text-[0.9375rem] text-highlighted">
                <Transition name="vh-install-swap" mode="out-in">
                  <code :key="activeInstallText" class="block overflow-x-auto whitespace-nowrap py-1 [scrollbar-width:thin]">{{ activeInstallText }}</code>
                </Transition>
              </span>
              <span class="relative ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-highlighted transition-colors group-hover:bg-muted">
                <Transition name="vh-install-copy" mode="out-in">
                  <UIcon
                    :key="copiedInstall ? 'check' : 'copy'"
                    :name="copiedInstall ? 'i-lucide-check' : 'i-lucide-copy'"
                    class="size-3.5"
                    :class="copiedInstall ? 'text-primary' : 'text-muted'"
                    aria-hidden="true"
                  />
                </Transition>
              </span>
            </button>
          </div>

        </div>

        <div class="min-w-0">
          <div class="vh-hero-system relative z-10 overflow-visible rounded-sm bg-default ring-1 ring-default">
            <div class="grid gap-4 p-4 sm:p-5">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="text-xl font-semibold text-highlighted">One Agent Definition. Two runtime paths.</h2>
                </div>
                <span class="hidden shrink-0 rounded-sm border border-default bg-muted/40 px-2 py-1 font-mono text-xs text-muted sm:inline-flex">
                  defineAgent()
                </span>
              </div>

              <div class="vh-hero-orbit-wrap">
                <div class="vh-hero-orbit-core" aria-hidden="true">
                  <div class="vh-hero-recipe-shell">
                    <svg class="vh-hero-recipe-mark" viewBox="0 0 120 120" aria-hidden="true">
                      <path
                        class="vh-hero-recipe-mark-fill"
                        d="M37 10H83Q91 10 95 17L116 53Q120 60 116 67L95 103Q91 110 83 110H37Q29 110 25 103L4 67Q0 60 4 53L25 17Q29 10 37 10Z"
                      />
                      <path
                        class="vh-hero-recipe-mark-stroke"
                        d="M37 10H83Q91 10 95 17L116 53Q120 60 116 67L95 103Q91 110 83 110H37Q29 110 25 103L4 67Q0 60 4 53L25 17Q29 10 37 10Z"
                        pathLength="1"
                      />
                    </svg>
                    <div
                      v-for="(recipe, index) in heroAgentRecipes"
                      :key="recipe.agent"
                      class="vh-hero-recipe-card"
                      :style="{ '--vh-recipe-delay': `${index * 5}s` }"
                    >
                      <span class="vh-hero-recipe-channel">
                        <UIcon :name="recipe.channelIcon" class="size-4 shrink-0" aria-hidden="true" />
                        <span>{{ recipe.channel }}</span>
                      </span>
                      <span class="vh-hero-recipe-bridge">
                        <span class="vh-hero-recipe-chip">
                          <UIcon :name="recipe.workspaceIcon" class="size-3 shrink-0" aria-hidden="true" />
                          {{ recipe.workspace }}
                        </span>
                        <span class="vh-hero-recipe-flow" aria-hidden="true" />
                        <span class="vh-hero-recipe-chip">
                          <UIcon :name="recipe.capabilityIcon" class="size-3 shrink-0" aria-hidden="true" />
                          {{ recipe.capability }}
                        </span>
                      </span>
                      <strong>{{ recipe.agent }}</strong>
                    </div>
                  </div>
                </div>

                <div class="vh-hero-orbit-ring vh-hero-orbit-ring--cores">
                  <span class="sr-only">Agent core primitives</span>
                  <div
                    v-for="node in heroAgentCoreNodes"
                    :key="node.label"
                    class="vh-hero-orbit-anchor"
                    :style="{ '--vh-orbit-angle': `${node.angle}deg` }"
                  >
                    <button
                      type="button"
                      class="vh-hero-orbit-node vh-hero-orbit-node--core"
                      :aria-label="`${node.label}: ${node.summary} ${node.stat || ''} ${node.tokens.map(token => token.label).join(', ')}`"
                    >
                      <span class="vh-hero-orbit-node-main">
                        <UIcon :name="node.icon" class="size-4 shrink-0" aria-hidden="true" />
                        <span>{{ node.label }}</span>
                      </span>
                      <span class="vh-hero-orbit-node-detail">
                        <span class="vh-hero-orbit-node-copy">{{ node.summary }}</span>
                        <span v-if="node.stat" class="vh-hero-orbit-node-stat">{{ node.stat }}</span>
                        <span class="vh-hero-orbit-node-list" role="list">
                          <span v-for="token in node.tokens" :key="token.label" class="vh-hero-orbit-token" role="listitem">
                            <UIcon :name="token.icon" class="size-4 shrink-0" aria-hidden="true" />
                            <span>{{ token.label }}</span>
                          </span>
                        </span>
                      </span>
                    </button>
                  </div>
                </div>

                <div class="vh-hero-orbit-ring vh-hero-orbit-ring--providers">
                  <span class="sr-only">Provider targets</span>
                  <div
                    v-for="node in heroProviderNodes"
                    :key="node.label"
                    class="vh-hero-orbit-anchor"
                    :style="{ '--vh-orbit-angle': `${node.angle}deg` }"
                  >
                    <span class="vh-hero-orbit-node vh-hero-orbit-node--provider" :aria-label="node.label">
                      <UIcon :name="node.icon" class="size-5 shrink-0" aria-hidden="true" />
                      <span class="sr-only">{{ node.label }}</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p class="sr-only">
            ViteHub orbits an Agent Definition around Channels, Capabilities, Driver behavior, Workspace context, and provider targets such as Cloudflare, Vercel, Netlify, Node, AWS, and Fly.io. The center cycles recipes for Review, Support, Field, Onboarding, Ops, and Community Agents.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section class="overflow-hidden border-y border-default bg-default">
    <div class="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)] lg:items-center lg:px-8">
      <div>
        <h2 class="max-w-[18ch] text-3xl font-semibold text-highlighted text-balance sm:text-4xl">
          Add server features without leaving Vite.
        </h2>
        <p class="mt-4 max-w-[64ch] text-base/7 text-muted text-pretty">
          Register <code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em] text-highlighted">vitehub()</code> and keep building in the app you already know. ViteHub prepares agents, storage, schedules, and workflows for your host, so you do not have to stitch server glue together.
        </p>
        <dl class="mt-6 grid gap-3 sm:grid-cols-3">
          <div class="border-l border-default pl-3">
            <dt class="flex items-center gap-2 text-sm font-semibold text-highlighted">
              <UIcon name="i-lucide-search-code" class="size-4 text-primary" aria-hidden="true" />
              Stay in Vite
            </dt>
            <dd class="mt-1 text-sm/6 text-muted">Keep server features beside the app code that uses them.</dd>
          </div>
          <div class="border-l border-default pl-3">
            <dt class="flex items-center gap-2 text-sm font-semibold text-highlighted">
              <UIcon name="i-lucide-layers" class="size-4 text-primary" aria-hidden="true" />
              Skip setup work
            </dt>
            <dd class="mt-1 text-sm/6 text-muted">Let ViteHub prepare the runtime files your app needs.</dd>
          </div>
          <div class="border-l border-default pl-3">
            <dt class="flex items-center gap-2 text-sm font-semibold text-highlighted">
              <UIcon name="i-lucide-server" class="size-4 text-primary" aria-hidden="true" />
              Deploy clearly
            </dt>
            <dd class="mt-1 text-sm/6 text-muted">Use the same project on Cloudflare, Vercel, Netlify, or Node.</dd>
          </div>
        </dl>
      </div>

      <div class="relative min-w-0 overflow-hidden py-8">
        <div class="vh-landing-code-card relative z-10">
          <div class="vh-landing-code-header">
            <UIcon name="i-vscode-icons-file-type-vite" class="size-4 shrink-0" />
            <span>vite.config.ts</span>
          </div>
          <div class="code-block-wrapper">
            <div v-if="highlightedPluginCode" v-html="highlightedPluginCode" />
            <pre v-else><code>{{ pluginCode }}</code></pre>
          </div>
        </div>
      </div>
    </div>

    <div class="sr-only">
      <p v-for="group in platformSignalSummaries" :key="group.label">
        {{ group.label }}: {{ group.text }}
      </p>
    </div>

    <div class="vh-platform-marquee-layer vh-platform-marquee-layer--integration" aria-hidden="true">
      <div
        v-for="(group, groupIndex) in platformSignalGroups"
        :key="group.label"
        class="vh-platform-marquee"
        :class="groupIndex === 1 && 'vh-platform-marquee--reverse'"
      >
        <div class="vh-platform-marquee-track">
          <div v-for="copy in 4" :key="copy" class="flex shrink-0 gap-2 pr-2">
            <span
              v-for="signal in group.signals"
              :key="`${copy}-${signal.label}`"
              class="inline-flex h-9 shrink-0 items-center gap-2 rounded-sm bg-default px-3 text-sm font-medium text-default"
            >
              <UIcon
                :name="signal.icon"
                class="size-4 shrink-0 text-[var(--vh-signal-color)]"
                :style="{ '--vh-signal-color': signal.color || 'currentColor' }"
                aria-hidden="true"
              />
              <span>{{ signal.label }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="bg-default">
    <div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <div class="max-w-3xl">
        <h2 class="max-w-[18ch] text-3xl font-semibold text-highlighted text-balance sm:text-4xl">
          Define agents before exposing abilities.
        </h2>
        <p class="mt-4 max-w-[62ch] text-base/7 text-muted text-pretty">
          An Agent Definition is the durable server primitive for server-side behavior. Capabilities then expose controlled access only when an Agent needs to read, write, invoke, or run code.
        </p>
      </div>

      <div class="mt-10 grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(24rem,5fr)] lg:items-start">
        <div class="space-y-5 lg:space-y-0">
          <div
            v-for="(step, index) in capabilitySteps"
            :key="step.title"
            :ref="(element: unknown) => setCapabilityStepElement(element, index)"
            :data-capability-step="index"
            class="vh-capability-step-frame lg:min-h-[46vh]"
          >
            <article
              v-motion
              class="vh-capability-step rounded-sm border p-4 lg:sticky lg:top-[calc(var(--ui-header-height)+2rem)] lg:min-h-[32vh] lg:p-5"
              :initial="{ opacity: 0.34, y: 0, scale: 1 }"
              :animate="getCapabilityStepMotion(index)"
              :transition="capabilityStepTransition"
              :class="
                activeCapabilityStep === index
                  ? 'border-default opacity-100'
                  : 'border-transparent opacity-40'
              "
            >
              <div class="flex items-start gap-4">
                <span
                  class="mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-sm border bg-muted text-muted transition-colors duration-300 motion-reduce:transition-none"
                  :class="activeCapabilityStep === index ? 'border-primary/40 text-primary' : 'border-default'"
                >
                  <UIcon :name="step.icon" class="size-4" />
                </span>
                <div class="min-w-0">
                  <h3 class="text-2xl font-semibold text-highlighted text-balance">
                    {{ step.title }}
                  </h3>
                  <p class="mt-3 max-w-[62ch] text-base/7 text-muted text-pretty">
                    {{ step.text }}
                  </p>
                </div>
              </div>
            </article>
          </div>
        </div>

        <aside
          v-motion
          class="lg:sticky lg:top-[calc(var(--ui-header-height)+2rem)] lg:self-start"
          :initial="{ opacity: 0, y: 24 }"
          :whileInView="{ opacity: 1, y: 0 }"
          :viewport="{ once: true, amount: 0.25 }"
          :transition="capabilityCodeCardTransition"
        >
          <div
            class="vh-agent-diff-card overflow-hidden rounded-sm ring-1 ring-default"
            :aria-label="`Diff for ${activeCapabilityDiff.label}`"
          >
            <div class="vh-agent-diff-body min-h-[20rem] overflow-x-auto p-3 font-mono text-[0.8125rem] leading-6 sm:text-sm">
              <Transition name="vh-agent-diff" mode="out-in">
                <div :key="activeCapabilityStep" class="min-w-max">
                  <div
                    v-for="(line, lineIndex) in activeCapabilityDiff.lines"
                    :key="`${activeCapabilityStep}-${lineIndex}-${line.kind}`"
                    class="vh-agent-diff-line"
                    :class="`vh-agent-diff-line--${line.kind}`"
                  >
                    <span class="vh-agent-diff-line-number">{{ line.oldLine || ' ' }}</span>
                    <span class="vh-agent-diff-line-number">{{ line.newLine || ' ' }}</span>
                    <span class="vh-agent-diff-marker">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}</span>
                    <code
                      v-if="highlightedCapabilityLines.length"
                      class="vh-agent-diff-code"
                      v-html="highlightedCapabilityLine(lineIndex)"
                    />
                    <code v-else class="vh-agent-diff-code">{{ line.text || ' ' }}</code>
                  </div>
                </div>
              </Transition>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </section>

  <section class="bg-muted/20">
    <div class="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
      <div class="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 class="text-3xl font-semibold text-highlighted text-balance sm:text-4xl">
            Inspect the primitive API after the agent story is clear.
          </h2>
          <p class="mt-3 max-w-[64ch] text-base/7 text-muted text-pretty">
            Switch the primitive, framework, or host output without changing app-facing Definitions.
          </p>
        </div>
        <NuxtLink :to="activeDocsLink" class="hidden shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-primary hover:text-primary/75 sm:flex">
          Read docs
          <UIcon name="i-lucide-arrow-right" class="size-3" />
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
            <p class="shrink-0 text-[0.625rem] font-medium tracking-wider text-muted uppercase">Works with</p>
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
            Read docs
            <UIcon name="i-lucide-arrow-right" class="size-3" />
          </NuxtLink>
        </div>
      </div>
    </div>
  </section>

  <section class="border-t border-default bg-default">
    <div class="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)] lg:px-8">
      <div>
        <h2 class="max-w-[16ch] text-3xl font-semibold text-highlighted text-balance sm:text-4xl">
          One model, clear handoffs.
        </h2>
        <p class="mt-4 max-w-[58ch] text-base/7 text-muted text-pretty">
          A Definition gives work a name. A Runtime Helper is what your app imports. A Capability controls what an Agent can touch. Provider Output is generated for the host.
        </p>
        <div class="mt-7 flex flex-wrap gap-2">
          <NuxtLink to="/docs/concepts/how-vitehub-fits-together" class="inline-flex items-center gap-1 rounded-sm bg-primary px-3 py-2 text-sm font-medium text-inverted hover:bg-primary/90">
            Read the model
            <UIcon name="i-lucide-arrow-right" class="size-3.5" aria-hidden="true" />
          </NuxtLink>
          <NuxtLink to="/docs/agents" class="inline-flex items-center gap-1 rounded-sm px-3 py-2 text-sm font-medium text-highlighted ring-1 ring-default hover:bg-muted">
            Start with agents
          </NuxtLink>
          <NuxtLink to="/docs/server-primitives" class="inline-flex items-center gap-1 rounded-sm px-3 py-2 text-sm font-medium text-highlighted ring-1 ring-default hover:bg-muted">
            Browse primitives
          </NuxtLink>
        </div>
      </div>

      <dl class="divide-y divide-default border-y border-default">
        <div class="grid gap-3 py-5 sm:grid-cols-[10rem_1fr]">
          <dt class="flex items-center gap-2 font-mono text-sm font-medium text-muted">
            <UIcon name="i-lucide-file-code-2" class="size-4 text-primary" aria-hidden="true" />
            Definition
          </dt>
          <dd>
            <h3 class="text-base font-semibold text-highlighted">Name the work once.</h3>
            <p class="mt-1 text-sm/6 text-muted text-pretty">
              Define an Agent, Workspace, Queue, Workflow, Schedule, or Sandbox in app code. ViteHub can discover it without tying it to one framework runtime.
            </p>
          </dd>
        </div>
        <div class="grid gap-3 py-5 sm:grid-cols-[10rem_1fr]">
          <dt class="flex items-center gap-2 font-mono text-sm font-medium text-muted">
            <UIcon name="i-lucide-terminal" class="size-4 text-primary" aria-hidden="true" />
            Runtime Helper
          </dt>
          <dd>
            <h3 class="text-base font-semibold text-highlighted">Call the ViteHub surface.</h3>
            <p class="mt-1 text-sm/6 text-muted text-pretty">
              App routes and server code import Runtime Helpers. Generated files and provider SDK setup stay behind the integration.
            </p>
          </dd>
        </div>
        <div class="grid gap-3 py-5 sm:grid-cols-[10rem_1fr]">
          <dt class="flex items-center gap-2 font-mono text-sm font-medium text-muted">
            <UIcon name="i-lucide-blocks" class="size-4 text-primary" aria-hidden="true" />
            Capability
          </dt>
          <dd>
            <h3 class="text-base font-semibold text-highlighted">Give the Agent a narrow handle.</h3>
            <p class="mt-1 text-sm/6 text-muted text-pretty">
              Attach a Capability when the Agent needs model-facing access to a named ability, such as storage, search, shell, or workspace files.
            </p>
          </dd>
        </div>
        <div class="grid gap-3 py-5 sm:grid-cols-[10rem_1fr]">
          <dt class="flex items-center gap-2 font-mono text-sm font-medium text-muted">
            <UIcon name="i-lucide-route" class="size-4 text-primary" aria-hidden="true" />
            Provider Output
          </dt>
          <dd>
            <h3 class="text-base font-semibold text-highlighted">Leave host wiring to the build.</h3>
            <p class="mt-1 text-sm/6 text-muted text-pretty">
              Vite Integrations write Runtime Registries, routes, bindings, crons, and runtime files as Provider Output so the result stays inspectable.
            </p>
          </dd>
        </div>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.vh-hero-system {
  background: var(--ui-bg);
}

.vh-hero-orbit-wrap {
  --vh-hero-core-size: 7rem;
  --vh-hero-inner-radius: 8.5rem;
  --vh-hero-inner-ring: 17rem;
  --vh-hero-outer-radius: 10.75rem;
  --vh-hero-outer-ring: 21.5rem;
  --vh-orbit-duration: 34s;

  position: relative;
  display: grid;
  min-height: 30rem;
  place-items: center;
  overflow: visible;
  border: 1px solid var(--ui-border);
  border-radius: 0.25rem;
  background: color-mix(in srgb, var(--ui-bg-muted) 55%, transparent);
  font-size: 0.875rem;
}

.vh-hero-orbit-wrap::before,
.vh-hero-orbit-wrap::after {
  content: "";
  position: absolute;
  inset: 50%;
  aspect-ratio: 1;
  border: 1px dashed color-mix(in srgb, var(--ui-primary) 28%, var(--ui-border));
  border-radius: 999px;
  transform: translate(-50%, -50%);
}

.vh-hero-orbit-wrap::before {
  width: var(--vh-hero-inner-ring);
}

.vh-hero-orbit-wrap::after {
  width: var(--vh-hero-outer-ring);
}

.vh-hero-orbit-core {
  position: relative;
  z-index: 4;
  display: grid;
  width: var(--vh-hero-core-size);
  height: var(--vh-hero-core-size);
  place-items: center;
}

.vh-hero-recipe-shell {
  position: relative;
  isolation: isolate;
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
}

.vh-hero-recipe-mark {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.vh-hero-recipe-mark-fill {
  z-index: 2;
  fill: var(--ui-text-highlighted);
  transform-box: fill-box;
  transform-origin: center;
  animation: vh-hero-recipe-fill 5s cubic-bezier(0.23, 1, 0.32, 1) infinite;
}

.vh-hero-recipe-mark-stroke {
  fill: color-mix(in srgb, var(--ui-bg) 94%, var(--ui-bg-muted) 6%);
  stroke: var(--ui-text-highlighted);
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  stroke-linejoin: round;
  stroke-width: 1.5;
  animation: vh-hero-recipe-stroke 5s cubic-bezier(0.23, 1, 0.32, 1) infinite;
}

.vh-hero-recipe-card {
  position: absolute;
  z-index: 3;
  inset: 1rem 0.6rem;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 0.34rem;
  color: var(--ui-text-highlighted);
  opacity: 0;
  text-align: center;
  animation: vh-hero-recipe-card 30s cubic-bezier(0.23, 1, 0.32, 1) infinite;
  animation-delay: var(--vh-recipe-delay);
}

.vh-hero-recipe-channel,
.vh-hero-recipe-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.vh-hero-recipe-channel {
  gap: 0.25rem;
  font-size: 0.76rem;
  font-weight: 800;
  line-height: 1;
}

.vh-hero-recipe-bridge {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 0.5rem minmax(0, 1fr);
  align-items: center;
  gap: 0.18rem;
  width: min(8.5rem, 100%);
  color: color-mix(in srgb, var(--ui-text-highlighted) 78%, var(--ui-text-muted));
  font-size: 0.55rem;
  font-weight: 700;
  line-height: 1;
}

.vh-hero-recipe-chip {
  min-width: 0;
  gap: 0.18rem;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
  border-radius: 999px;
  padding: 0.22rem 0.32rem;
  background: color-mix(in srgb, var(--ui-bg) 78%, transparent);
  animation: vh-hero-recipe-chip 5s cubic-bezier(0.23, 1, 0.32, 1) infinite;
  animation-delay: var(--vh-recipe-delay);
  white-space: nowrap;
}

.vh-hero-recipe-flow {
  display: block;
  width: 0.32rem;
  height: 0.32rem;
  border-radius: 999px;
  background: var(--ui-text-highlighted);
  opacity: 0.42;
  animation: vh-hero-recipe-flow 5s cubic-bezier(0.23, 1, 0.32, 1) infinite;
  animation-delay: var(--vh-recipe-delay);
}

.vh-hero-recipe-card strong {
  max-width: 8.5ch;
  font-size: 0.9rem;
  font-weight: 800;
  line-height: 1.05;
}

.vh-hero-orbit-ring {
  position: absolute;
  z-index: 3;
  inset: 50%;
  width: 0;
  height: 0;
  animation: vh-hero-orbit-spin var(--vh-orbit-duration) linear infinite;
  transform-origin: center;
}

.vh-hero-orbit-ring--cores {
  --vh-orbit-duration: 38s;
  --vh-orbit-radius: var(--vh-hero-inner-radius);

  animation-direction: reverse;
  z-index: 4;
}

.vh-hero-orbit-ring--providers {
  --vh-orbit-duration: 56s;
  --vh-orbit-radius: var(--vh-hero-outer-radius);

  z-index: 3;
}

.vh-hero-orbit-anchor {
  position: absolute;
  inset: 0;
  transform: rotate(var(--vh-orbit-angle)) translateX(var(--vh-orbit-radius));
  transform-origin: 0 0;
}

.vh-hero-orbit-anchor:has(.vh-hero-orbit-node--core:hover),
.vh-hero-orbit-anchor:has(.vh-hero-orbit-node--core:focus-visible) {
  z-index: 20;
}

.vh-hero-orbit-node {
  appearance: none;
  position: relative;
  display: inline-flex;
  min-width: 7rem;
  height: 2.5rem;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
  padding: 0.5rem 0.65rem;
  color: var(--ui-text);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  animation: vh-hero-orbit-counter var(--vh-orbit-duration) linear infinite;
  transform: translate(-50%, -50%) rotate(calc(-1 * var(--vh-orbit-angle)));
  white-space: nowrap;
}

.vh-hero-orbit-node--core {
  width: 8.75rem;
  overflow: hidden;
  cursor: pointer;
  transition:
    width 220ms cubic-bezier(0.23, 1, 0.32, 1),
    height 220ms cubic-bezier(0.23, 1, 0.32, 1),
    box-shadow 180ms ease,
    background-color 180ms ease;
}

.vh-hero-orbit-node--provider {
  min-width: 0;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 999px;
  padding: 0;
  transition: opacity 160ms ease;
}

.vh-hero-orbit-ring--cores .vh-hero-orbit-node {
  animation-direction: reverse;
}

.vh-hero-orbit-node-main {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
}

.vh-hero-orbit-node-detail {
  position: absolute;
  top: 50%;
  right: 0.9rem;
  left: 7.75rem;
  display: grid;
  gap: 0.35rem;
  overflow: visible;
  color: var(--ui-text-muted);
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1.35;
  opacity: 0;
  visibility: hidden;
  text-align: left;
  transition:
    opacity 140ms ease,
    visibility 140ms ease;
  transform: translateY(-50%);
  white-space: normal;
}

.vh-hero-orbit-node-copy {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.vh-hero-orbit-node-stat {
  color: var(--ui-text);
  font-weight: 600;
}

.vh-hero-orbit-node-list {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.vh-hero-orbit-token {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
  border-radius: 999px;
  padding: 0.25rem 0.5rem 0.25rem 0.25rem;
  background: color-mix(in srgb, var(--ui-bg-muted) 44%, transparent);
  color: var(--ui-text);
  line-height: 1;
}

.vh-hero-orbit-node--core:hover,
.vh-hero-orbit-node--core:focus-visible {
  z-index: 6;
  width: 24rem;
  height: 8.75rem;
  justify-content: flex-start;
  background: var(--ui-bg);
  box-shadow: 0 1rem 2.5rem color-mix(in srgb, var(--ui-bg-inverted) 10%, transparent);
}

.vh-hero-orbit-node--core:hover .vh-hero-orbit-node-detail,
.vh-hero-orbit-node--core:focus-visible .vh-hero-orbit-node-detail {
  opacity: 1;
  visibility: visible;
}

.vh-hero-orbit-wrap:has(.vh-hero-orbit-node:hover) .vh-hero-orbit-ring,
.vh-hero-orbit-wrap:has(.vh-hero-orbit-node:focus-visible) .vh-hero-orbit-ring,
.vh-hero-orbit-wrap:has(.vh-hero-orbit-node:hover) .vh-hero-orbit-node,
.vh-hero-orbit-wrap:has(.vh-hero-orbit-node:focus-visible) .vh-hero-orbit-node {
  animation-play-state: paused;
}

.vh-hero-orbit-wrap:has(.vh-hero-orbit-node--core:hover) .vh-hero-orbit-node--provider,
.vh-hero-orbit-wrap:has(.vh-hero-orbit-node--core:focus-visible) .vh-hero-orbit-node--provider {
  opacity: 0.18;
}

@media (width >= 48rem) {
  .vh-hero-orbit-wrap {
    --vh-hero-core-size: 9.25rem;
    --vh-hero-inner-radius: 11.25rem;
    --vh-hero-inner-ring: 22.5rem;
    --vh-hero-outer-radius: 16.5rem;
    --vh-hero-outer-ring: 33rem;

    min-height: 38rem;
  }

  .vh-hero-recipe-card {
    inset: 1.45rem 1rem;
    gap: 0.45rem;
  }

  .vh-hero-recipe-channel {
    font-size: 0.95rem;
  }

  .vh-hero-recipe-bridge {
    width: 9.2rem;
    font-size: 0.64rem;
  }

  .vh-hero-recipe-card strong {
    font-size: 1.1rem;
  }
}

@keyframes vh-hero-orbit-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes vh-hero-orbit-counter {
  to {
    transform: translate(-50%, -50%) rotate(calc(-360deg - var(--vh-orbit-angle)));
  }
}

@keyframes vh-hero-recipe-fill {
  0% {
    opacity: 1;
    transform: scale(0.72);
  }

  18% {
    opacity: 1;
    transform: scale(1);
  }

  34%,
  100% {
    opacity: 0;
    transform: scale(1);
  }
}

@keyframes vh-hero-recipe-stroke {
  0%,
  12% {
    stroke-dashoffset: 1;
  }

  32%,
  100% {
    stroke-dashoffset: 0;
  }
}

@keyframes vh-hero-recipe-card {
  0%,
  4% {
    opacity: 0;
    transform: translateY(0.25rem) scale(0.94);
  }

  7%,
  14% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  17%,
  100% {
    opacity: 0;
    transform: translateY(-0.15rem) scale(0.98);
  }
}

@keyframes vh-hero-recipe-chip {
  0%,
  8% {
    transform: translateY(0.08rem);
  }

  13%,
  100% {
    transform: translateY(0);
  }
}

@keyframes vh-hero-recipe-flow {
  0%,
  12% {
    transform: scale(0.5);
  }

  18%,
  100% {
    transform: scale(1);
  }
}

.vh-platform-marquee-layer {
  position: absolute;
  inset: 4rem -8rem -8rem -4.5rem;
  z-index: 0;
  display: grid;
  align-content: center;
  gap: 1.25rem;
  overflow: hidden;
  opacity: 0.9;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  transform: rotate(-5deg);
}

.vh-platform-marquee-layer--integration {
  position: relative;
  inset: auto;
  width: 100vw;
  margin-left: calc(50% - 50vw);
  align-content: center;
  gap: 0.5rem;
  border-block: 1px solid var(--ui-border);
  padding-block: 0.75rem;
  opacity: 1;
  transform: none;
}

.vh-platform-marquee {
  display: flex;
  overflow: hidden;
  padding-block: 0.25rem;
}

.vh-platform-marquee--reverse {
  transform: translateX(-1.5rem);
}

.vh-platform-marquee-track {
  display: flex;
  width: max-content;
  animation: vh-platform-marquee 28s linear infinite;
}

.vh-platform-marquee--reverse .vh-platform-marquee-track {
  animation-name: vh-platform-marquee-reverse;
  animation-duration: 32s;
}

@keyframes vh-platform-marquee {
  to {
    transform: translateX(-50%);
  }
}

@keyframes vh-platform-marquee-reverse {
  from {
    transform: translateX(-50%);
  }
}

.vh-install-swap-enter-active,
.vh-install-swap-leave-active,
.vh-install-copy-enter-active,
.vh-install-copy-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1),
    filter 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.vh-install-swap-enter-from,
.vh-install-swap-leave-to {
  opacity: 0;
  filter: blur(1px);
  transform: translateY(2px);
}

.vh-install-copy-enter-from,
.vh-install-copy-leave-to {
  opacity: 0;
  filter: blur(1px);
  transform: scale(0.8);
}

.vh-agent-diff-card {
  background: #ffffff;
  color: #24292f;
}

.vh-agent-diff-body {
  background: #ffffff;
  scrollbar-width: thin;
}

.vh-agent-diff-line {
  display: grid;
  grid-template-columns: 2.4rem 2.4rem 1.4rem minmax(28rem, 1fr);
  min-height: 1.5rem;
  align-items: center;
  border-left: 2px solid transparent;
}

.vh-agent-diff-line--context {
  color: #24292f;
}

.vh-agent-diff-line--add {
  border-left-color: #1f883d;
  background: #dafbe1;
  color: #24292f;
}

.vh-agent-diff-line--remove {
  border-left-color: #cf222e;
  background: #ffebe9;
  color: #24292f;
}

.vh-agent-diff-line-number,
.vh-agent-diff-marker {
  color: #6e7681;
  text-align: right;
  user-select: none;
}

.vh-agent-diff-marker {
  padding-right: 0.5rem;
  text-align: center;
}

.vh-agent-diff-code {
  display: block;
  padding-right: 1rem;
  padding-left: 0.5rem;
  white-space: pre;
}

.vh-agent-diff-code :deep(.line) {
  display: contents;
}

.vh-agent-diff-enter-active,
.vh-agent-diff-leave-active {
  transition:
    opacity 220ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 220ms cubic-bezier(0.23, 1, 0.32, 1);
}

.vh-agent-diff-enter-from {
  opacity: 0;
  transform: translateY(0.5rem);
}

.vh-agent-diff-leave-to {
  opacity: 0;
  transform: translateY(-0.5rem);
}

@media (prefers-reduced-motion: reduce) {
  .vh-install-swap-enter-active,
  .vh-install-swap-leave-active,
  .vh-install-copy-enter-active,
  .vh-install-copy-leave-active,
  .vh-agent-diff-enter-active,
  .vh-agent-diff-leave-active {
    transition-duration: 0ms;
  }

  .vh-platform-marquee-track {
    animation: none;
    transform: none;
  }

  .vh-hero-orbit-ring,
  .vh-hero-orbit-node,
  .vh-hero-recipe-mark-fill,
  .vh-hero-recipe-mark-stroke,
  .vh-hero-recipe-card,
  .vh-hero-recipe-chip,
  .vh-hero-recipe-flow {
    animation: none;
  }

  .vh-hero-recipe-card {
    opacity: 0;
  }

  .vh-hero-recipe-mark-fill {
    opacity: 0;
  }

  .vh-hero-recipe-mark-stroke {
    stroke-dashoffset: 0;
  }

  .vh-hero-recipe-card:first-of-type {
    opacity: 1;
    transform: none;
  }
}
</style>
