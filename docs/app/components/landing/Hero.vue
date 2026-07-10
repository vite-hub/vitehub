<script setup lang="ts">
import { computed, ref } from "vue";
import { useHighlightedCode } from "../../composables/useHighlightedCode";

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
</script>

<template>
  <section class="vh-ground-grid relative isolate overflow-hidden bg-default">
    <div class="mx-auto grid max-w-7xl gap-12 px-4 pt-16 pb-14 sm:px-8 lg:grid-cols-[19fr_21fr] lg:items-center lg:px-12 lg:pt-24 lg:pb-20">
      <div class="min-w-0">
        <h1 class="max-w-[20ch] text-5xl font-semibold tracking-tight text-highlighted text-balance sm:text-6xl lg:text-7xl">
          Agents for any host.
        </h1>
        <p class="mt-6 max-w-[48ch] text-lg text-muted text-pretty">
          Choose a model-backed, harness-backed, or custom Agent Driver. Add Channels, Capabilities, Workspace context, and Server Primitives only when the product needs them, then ship to any Vite host.
        </p>

        <div class="mt-9 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <NuxtLink to="/docs/getting-started/first-agent" class="inline-flex items-center gap-1 font-medium text-highlighted hover:text-primary">
            Build your first Agent
            <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
          </NuxtLink>
          <NuxtLink to="/docs/server-primitives" class="inline-flex items-center gap-1 font-medium text-muted hover:text-default">
            Use Server Primitives
          </NuxtLink>
          <NuxtLink to="/docs" class="inline-flex items-center gap-1 font-medium text-muted hover:text-default">
            Read the docs
          </NuxtLink>
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
