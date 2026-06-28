<script setup lang="ts">
import { computed, ref } from "vue";
import { useHighlightedCode } from "../../composables/useHighlightedCode";

const pillars = [
  {
    icon: "i-lucide-cpu",
    title: "How it runs",
    text: "A model, a coding harness, or your own code drives each run.",
    badges: ["GPT-5.5", "Claude Code", "MiniMax"],
    note: "Powered by the AI SDK",
  },
  {
    icon: "i-lucide-folder-tree",
    title: "Workspace",
    text: "A cloud Linux file system your agent explores with real bash commands.",
    badges: ["ls", "cat", "grep", "git"],
    note: "",
  },
  {
    icon: "i-lucide-blocks",
    title: "Capabilities",
    text: "Named abilities you grant on top, never raw access.",
    badges: ["web search", "MCP", "storage", "git"],
    note: "",
  },
  {
    icon: "i-lucide-radio",
    title: "Channels",
    text: "Reach the same agent from anywhere it should answer.",
    badges: ["Slack", "GitHub", "Web", "HTTP"],
    note: "",
  },
  {
    icon: "i-lucide-file-text",
    title: "Instructions",
    text: "Behavior written as composable Markdown instruction documents.",
    badges: [],
    note: "",
  },
] as const;

const files = [
  {
    id: "config",
    label: "config.ts",
    icon: "i-vscode-icons-file-type-typescript-official",
    lang: "ts",
    code: `export default defineAgent({
  driver: { model: openai('gpt-5.1') },
  workspace: { sources: { docs: github('acme/docs') } },
  channels: { slack: slack() },
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
    id: "instructions",
    label: "instructions.md",
    icon: "i-vscode-icons-file-type-markdown",
    lang: "md",
    code: `# Support agent

Answer for {{ context.customer }} in a calm, concrete tone.

@./escalation.md

::if{context.staff}
You may reference internal runbooks and incident history.
::

{{ capabilities }}`,
  },
] as const;

const activeId = ref<string>(files[0]!.id);
const activeFile = computed(() => files.find(f => f.id === activeId.value) ?? files[0]!);
const { data: highlighted } = useHighlightedCode(() => activeFile.value.id, () => activeFile.value.code, () => activeFile.value.lang);
</script>

<template>
  <section class="border-t border-default bg-muted/30">
    <div class="mx-auto max-w-7xl px-4 py-16 sm:px-8 lg:px-12 lg:py-20">
      <h2 class="max-w-[28ch] text-4xl font-semibold tracking-tight text-highlighted text-balance">
        Composable by design.
      </h2>
      <p class="mt-5 max-w-[58ch] text-lg text-muted text-pretty">
        Start with an agent that works inside a cloud Linux workspace, driven by bash. Layer on capabilities, channels, and instructions as the product grows. Every part is an explicit boundary you compose.
      </p>

      <div class="mt-10 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
        <ul class="grid" role="list">
          <li
            v-for="(pillar, index) in pillars"
            :key="pillar.title"
            class="grid grid-cols-[auto_1fr] gap-4 py-5"
            :class="index > 0 && 'border-t border-default'"
          >
            <UIcon :name="pillar.icon" class="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
            <div class="min-w-0">
              <h3 class="text-base font-medium text-highlighted">{{ pillar.title }}</h3>
              <p class="mt-1 text-base text-muted text-pretty sm:text-sm/6">{{ pillar.text }}</p>
              <div v-if="pillar.badges.length || pillar.note" class="mt-3 flex flex-wrap items-center gap-1.5">
                <span
                  v-for="badge in pillar.badges"
                  :key="badge"
                  class="inline-flex items-center rounded-sm border border-default bg-default px-2 py-0.5 font-mono text-xs text-muted"
                >{{ badge }}</span>
                <span v-if="pillar.note" class="font-mono text-xs text-dimmed">{{ pillar.note }}</span>
              </div>
            </div>
          </li>
        </ul>

        <div class="vh-landing-code-card lg:sticky lg:top-[calc(var(--ui-header-height)+2rem)]">
          <div class="vh-landing-code-header gap-2 px-3">
            <UIcon name="i-lucide-folder" class="size-4 shrink-0" aria-hidden="true" />
            <span class="font-mono">server/agents/support</span>
          </div>
          <div class="flex">
            <ul class="shrink-0 border-r border-default bg-muted/40 py-2" role="list">
              <li v-for="file in files" :key="file.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  :class="activeId === file.id ? 'bg-default text-highlighted' : 'text-muted hover:text-default'"
                  @click="activeId = file.id"
                >
                  <UIcon :name="file.icon" class="size-4 shrink-0" aria-hidden="true" />
                  <span class="font-mono">{{ file.label }}</span>
                </button>
              </li>
            </ul>
            <div class="code-block-wrapper min-h-[19rem] flex-1 overflow-x-auto text-sm" v-html="highlighted" />
          </div>
        </div>
      </div>

      <div class="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <NuxtLink to="/docs/capabilities" class="inline-flex items-center gap-1 font-medium text-highlighted hover:text-primary">
          Browse capabilities
          <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink to="/docs/agents/instructions" class="inline-flex items-center gap-1 font-medium text-muted hover:text-default">
          Instruction documents
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
