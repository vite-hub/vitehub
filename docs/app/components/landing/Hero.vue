<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useHighlightedCode } from "../../composables/useHighlightedCode";

const installAudiences = [
  { label: "For humans", value: "humans", icon: "i-lucide-user" },
  { label: "For agents", value: "agents", icon: "i-lucide-bot" },
] as const;

const packageManagers = [
  { label: "pnpm", value: "pnpm", icon: "i-simple-icons-pnpm", command: "pnpm add @vite-hub/vite" },
  { label: "npm", value: "npm", icon: "i-simple-icons-npm", command: "npm install @vite-hub/vite" },
  { label: "bun", value: "bun", icon: "i-simple-icons-bun", command: "bun add @vite-hub/vite" },
  { label: "yarn", value: "yarn", icon: "i-simple-icons-yarn", command: "yarn add @vite-hub/vite" },
] as const;

const agentInstallCommand = "npx skills add https://vitehub.dev";

type InstallAudience = (typeof installAudiences)[number]["value"];
type PackageManager = (typeof packageManagers)[number]["value"];

const activeAudience = ref<InstallAudience>("humans");
const activeManager = ref<PackageManager>("pnpm");
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const selectedManager = computed(() => packageManagers.find(m => m.value === activeManager.value) ?? packageManagers[0]!);
const installText = computed(() => (activeAudience.value === "humans" ? selectedManager.value.command : agentInstallCommand));

async function copyInstall() {
  try {
    await navigator.clipboard?.writeText(installText.value);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {}
}

const agents = [
  {
    id: "pr-reviewer",
    label: "pr-reviewer",
    icon: "i-lucide-git-pull-request",
    code: `export default defineAgent({
  driver: { harness: claudeCode() },
  workspace: { source: github('acme/app') },
  channels: { github: github() },
  capabilities: [
    git(),
    mcp({ browser: playwright() }),
    workspaceShell(),
  ],
})`,
  },
  {
    id: "support",
    label: "support",
    icon: "i-lucide-messages-square",
    code: `export default defineAgent({
  driver: { model: openai('gpt-5.1') },
  workspace: { sources: { docs: github('acme/docs') } },
  channels: { web: webChat() },
  capabilities: [
    access({
      scopes: {
        support: { sources: ['docs'] },
        staff: { sources: ['docs', 'internal'] },
      },
    }),
  ],
})`,
  },
  {
    id: "research",
    label: "research",
    icon: "i-lucide-telescope",
    code: `export default defineAgent({
  driver: { model: openai('gpt-5.1') },
  capabilities: [
    webSearch(),
    subagents({
      researcher: { model: openai('gpt-5.1-mini') },
    }),
  ],
})`,
  },
] as const;

const activeId = ref<string>(agents[0]!.id);
const activeAgent = computed(() => agents.find(a => a.id === activeId.value) ?? agents[0]!);
const { data: highlighted } = useHighlightedCode(() => activeAgent.value.id, () => activeAgent.value.code, "ts");

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <section class="vh-ground-grid relative isolate overflow-hidden bg-default">
    <div class="mx-auto grid max-w-7xl gap-12 px-4 pt-16 pb-14 sm:px-8 lg:grid-cols-[19fr_21fr] lg:items-center lg:px-12 lg:pt-24 lg:pb-20">
      <div class="min-w-0">
        <h1 class="max-w-[20ch] text-5xl font-semibold tracking-tight text-highlighted text-balance sm:text-6xl lg:text-7xl">
          Agents for any host.
        </h1>
        <p class="mt-6 max-w-[48ch] text-lg text-muted text-pretty">
          Define any agent, compose it from capabilities, and ship the same code to any host. Built on server primitives, wired with one Vite plugin.
        </p>

        <div class="mt-9 flex w-full max-w-xl flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="inline-flex rounded-sm bg-muted/70 p-1 ring-1 ring-default" role="tablist" aria-label="Install audience">
              <button
                v-for="audience in installAudiences"
                :key="audience.value"
                type="button"
                role="tab"
                :aria-selected="activeAudience === audience.value"
                class="inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :class="activeAudience === audience.value ? 'bg-default text-highlighted ring-1 ring-default' : 'text-muted hover:text-default'"
                @click="activeAudience = audience.value"
              >
                <UIcon :name="audience.icon" class="size-3.5 shrink-0" aria-hidden="true" />
                <span>{{ audience.label }}</span>
              </button>
            </div>

            <div
              v-show="activeAudience === 'humans'"
              class="inline-flex items-center gap-1 rounded-sm bg-muted/70 p-1 ring-1 ring-default"
              role="radiogroup"
              aria-label="Package manager"
            >
              <button
                v-for="manager in packageManagers"
                :key="manager.value"
                type="button"
                role="radio"
                :aria-checked="activeManager === manager.value"
                :aria-label="manager.label"
                class="inline-flex h-7 items-center justify-center overflow-hidden rounded-sm text-sm font-medium transition-[width,color,background-color] duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :class="activeManager === manager.value ? 'w-20 bg-default px-2.5 text-highlighted ring-1 ring-default' : 'w-7 px-0 text-muted hover:text-default'"
                @click="activeManager = manager.value"
              >
                <UIcon :name="manager.icon" class="size-3.5 shrink-0" aria-hidden="true" />
                <span
                  class="overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin-left] duration-150 ease-out"
                  :class="activeManager === manager.value ? 'ml-1.5 max-w-12 opacity-100' : 'ml-0 max-w-0 opacity-0'"
                >{{ manager.label }}</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            class="group inline-flex w-full items-center gap-2 rounded-sm bg-default px-3 py-2.5 text-left ring-1 ring-default transition-colors hover:ring-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :aria-label="copied ? 'Copied' : 'Copy install command'"
            @click="copyInstall"
          >
            <span class="font-mono text-base text-dimmed select-none sm:text-sm" aria-hidden="true">$</span>
            <code class="min-w-0 flex-1 overflow-x-auto font-mono text-base whitespace-nowrap text-highlighted sm:text-sm [scrollbar-width:none]">{{ installText }}</code>
            <UIcon
              :name="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              class="size-4 shrink-0 transition-colors"
              :class="copied ? 'text-primary' : 'text-muted group-hover:text-default'"
              aria-hidden="true"
            />
          </button>

          <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <NuxtLink to="/docs/getting-started/first-agent" class="inline-flex items-center gap-1 font-medium text-highlighted hover:text-primary">
              Build your first agent
              <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
            </NuxtLink>
            <NuxtLink to="/docs" class="inline-flex items-center gap-1 font-medium text-muted hover:text-default">
              Read the docs
            </NuxtLink>
          </div>
        </div>
      </div>

      <div class="min-w-0">
        <div class="vh-landing-code-card">
          <div class="hide-scrollbar flex overflow-x-auto border-b border-default bg-muted" role="tablist" aria-label="Example agents">
            <button
              v-for="agent in agents"
              :key="agent.id"
              type="button"
              role="tab"
              :aria-selected="activeId === agent.id"
              class="-mb-px inline-flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              :class="activeId === agent.id ? 'border-highlighted bg-default text-highlighted' : 'border-transparent text-muted hover:text-default'"
              @click="activeId = agent.id"
            >
              <UIcon :name="agent.icon" class="size-4 shrink-0" aria-hidden="true" />
              <span>{{ agent.label }}</span>
            </button>
          </div>
          <div class="code-block-wrapper min-h-[23rem] overflow-x-auto text-sm" v-html="highlighted" />
        </div>
      </div>
    </div>
  </section>
</template>
