<script setup lang="ts">
import { useReducedMotion, type Options } from "motion-v";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useHighlightedCode } from "../../composables/useHighlightedCode";
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
  { label: "For coding agents", value: "agents", icon: "i-lucide-bot" },
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
      { label: "Docker", icon: "i-simple-icons-docker", color: "" },
      { label: "Deno", icon: "i-simple-icons-deno", color: "" },
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
    summary: "Reach users from product and platform surfaces without changing the agent.",
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
    summary: "Give the driver only the named abilities it needs for this run.",
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
    summary: "The engine boundary for model calls, streaming, usage, and lifecycle.",
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
    summary: "Put the model in a Linux-like project with your own files and sources.",
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
  { label: "Cloudflare", icon: "i-simple-icons-cloudflare", angle: 0 },
  { label: "Vercel", icon: "i-simple-icons-vercel", angle: 51 },
  { label: "Netlify", icon: "i-simple-icons-netlify", angle: 103 },
  { label: "Docker", icon: "i-simple-icons-docker", angle: 154 },
  { label: "Node", icon: "i-simple-icons-nodedotjs", angle: 206 },
  { label: "Deno", icon: "i-simple-icons-deno", angle: 257 },
  { label: "Fly.io", icon: "i-simple-icons-flydotio", angle: 309 },
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
      { kind: "add", newLine: "1", text: "import { defineAgent } from '@vite-hub/agent'" },
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
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/agent'" },
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
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/agent'" },
      { kind: "add", newLine: "2", text: "import {" },
      { kind: "add", newLine: "3", text: "  github," },
      { kind: "add", newLine: "4", text: "  stream," },
      { kind: "add", newLine: "5", text: "  webChat," },
      { kind: "add", newLine: "6", text: "} from '@vite-hub/agent/channels'" },
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
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/agent'" },
      { kind: "add", newLine: "2", text: "import {" },
      { kind: "add", newLine: "3", text: "  workspaceShell," },
      { kind: "add", newLine: "4", text: "} from '@vite-hub/agent/capabilities'" },
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
      { kind: "context", oldLine: "1", newLine: "1", text: "import { defineAgent } from '@vite-hub/agent'" },
      { kind: "remove", oldLine: "2", text: "import { workspaceShell } from '@vite-hub/agent/capabilities'" },
      { kind: "add", newLine: "2", text: "import {" },
      { kind: "add", newLine: "3", text: "  sandbox," },
      { kind: "add", newLine: "4", text: "  workspaceShell," },
      { kind: "add", newLine: "5", text: "} from '@vite-hub/agent/capabilities'" },
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
const poweredBy: Record<string, string> = {
  kv: "unstorage",
  db: "Drizzle",
  blob: "files-sdk",
  workflow: "OpenWorkflow",
  auth: "Better Auth",
  shell: "just-bash",
};
const activePoweredBy = computed(() => poweredBy[activeExample.value.docsPath] || poweredBy[activeExample.value.pkg] || "");
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

// Switching primitive tabs lands on its config unless the user already has a dirty selection.
watch(activeTab, () => {
  const phasePaths = getShowcasePhasePaths(activeExample.value, displayedFramework.value);
  const phase = (phasePaths.configure ? "configure" : activeExample.value.defaultPhase) as ShowcasePhaseId;
  activePhase.value = phase;
  applyFrameworkSelection(displayedFramework.value, { phase, provider: activeProvider.value });
}, { immediate: true });

watch(displayedFramework, resetSelection);

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
  <section class="bg-muted/20">
    <div class="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
      <div class="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 class="text-3xl font-semibold text-highlighted text-balance sm:text-4xl">
            See it for real.
          </h2>
          <p class="mt-3 max-w-[64ch] text-base/7 text-muted text-pretty">
            Switch the primitive, framework, or host. The app-facing code stays the same. Only the generated provider output changes.
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
          <div class="flex min-w-0 items-center gap-3">
            <p v-if="activePoweredBy" class="shrink-0 font-mono text-xs text-dimmed">Powered by {{ activePoweredBy }}</p>
            <div v-if="activeExample.providers.length" class="flex min-w-0 items-center gap-1.5">
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
          </div>
          <NuxtLink :to="activeDocsLink" class="flex min-w-[7rem] shrink-0 items-center justify-end gap-1 rounded-sm px-2 py-0.5 text-xs font-medium text-primary hover:text-primary/75 sm:hidden">
            Read docs
            <UIcon name="i-lucide-arrow-right" class="size-3" />
          </NuxtLink>
        </div>
      </div>
    </div>
  </section>
</template>
