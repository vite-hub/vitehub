<script setup lang="ts">
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "@vite-hub/ui";
import { computed, ref, watch } from "vue";

import type { ConsoleNavigation } from "../client/sections";
import { consoleAddablePrimitives, consoleAddCommand, consoleAddPrimitiveChoice, consoleAddPrimitiveOpen, consoleAddPrompt, groupConsolePrimitives } from "../client/add-primitive";
import { useConsoleToast } from "../client/toast";
import { consolePrimitives } from "../sections";
import ConsoleSectionIcon from "./console-section-icon.vue";

/**
 * Lists the primitives that the app does not use yet. A chosen primitive shows the `vitehub add` command and a prompt
 * for a coding agent. The Console never changes the app itself.
 */
const props = defineProps<{
  appName: string;
  navigation?: ConsoleNavigation;
}>();

const toast = useConsoleToast();
const query = ref("");
const addable = computed(() => consoleAddablePrimitives(props.navigation?.sections ?? []));
const groups = computed(() => groupConsolePrimitives(addable.value, query.value));
const chosen = computed(() => consolePrimitives.find(entry => entry.id === consoleAddPrimitiveChoice.value));
const command = computed(() => chosen.value && consoleAddCommand(chosen.value));
const prompt = computed(() => chosen.value && consoleAddPrompt(chosen.value));
const title = computed(() => chosen.value ? `Add ${chosen.value.label} to ${props.appName}` : `Add a primitive to ${props.appName}`);

watch(consoleAddPrimitiveOpen, (open) => {
  if (open) query.value = "";
});

function choose(id: string | undefined): void {
  consoleAddPrimitiveChoice.value = id;
}

/** Enter in the filter opens the first match, as in a command palette. */
function chooseFirst(): void {
  const first = groups.value[0]?.primitives[0];
  if (first) choose(first.id);
}

function copyFailed(): void {
  toast.show({ title: "The browser blocked the clipboard. Select the text and copy it." });
}
</script>

<template>
  <UModal
    v-model:open="consoleAddPrimitiveOpen"
    :title="title"
    :description="chosen ? chosen.pitch : 'Pick one. The Console gives you the vitehub add command for it.'"
    :ui="{ content: 'sm:max-w-[35rem]', body: chosen ? undefined : 'p-0 sm:p-0' }"
  >
    <template v-if="chosen" #title>
      <span class="flex items-center gap-2">
        <ConsoleSectionIcon :icon="chosen.icon" class="size-4.5 shrink-0" />
        {{ title }}
      </span>
    </template>

    <template #body>
      <div v-if="chosen" class="grid gap-5">
        <section v-if="command" class="grid gap-2" aria-labelledby="vitehub-add-primitive-command">
          <h3 id="vitehub-add-primitive-command" class="text-sm font-medium text-highlighted">Run in the app folder</h3>
          <CodeBlock size="sm">
            <CodeBlockHeader>
              <CodeBlockTitle>Terminal</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton :value="command" aria-label="Copy command" color="neutral" @error="copyFailed" />
              </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent>{{ command }}</CodeBlockContent>
          </CodeBlock>
          <p class="text-sm text-pretty text-muted">
            The CLI shows the change and asks before it writes a file. Then it installs the packages and edits the config.
            Add <code class="font-mono text-xs">--dry-run</code> to only see the change.
          </p>
        </section>
        <p v-else class="flex gap-2 rounded-md bg-elevated/60 px-3 py-2.5 text-sm text-pretty text-muted">
          <UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span><code class="font-mono text-xs">vitehub add</code> cannot set up {{ chosen.label }}. Your coding agent can, with this prompt.</span>
        </p>

        <section class="grid gap-2" aria-labelledby="vitehub-add-primitive-prompt">
          <h3 id="vitehub-add-primitive-prompt" class="text-sm font-medium text-highlighted">{{ command ? "Or ask your coding agent" : "Ask your coding agent" }}</h3>
          <CodeBlock size="sm">
            <CodeBlockHeader>
              <CodeBlockTitle>Prompt</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton :value="prompt ?? ''" aria-label="Copy prompt for your coding agent" color="neutral" @error="copyFailed" />
              </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent wrap>{{ prompt }}</CodeBlockContent>
          </CodeBlock>
        </section>

        <p class="text-sm text-pretty text-muted">When the app runs with the change, {{ chosen.label }} shows in the sidebar.</p>
      </div>

      <div v-else class="grid">
        <div class="px-4 pb-1 pt-4 sm:px-6">
          <UInput
            v-model="query"
            icon="i-lucide-search"
            placeholder="Filter"
            aria-label="Filter primitives"
            class="w-full"
            autofocus
            @keydown.enter.prevent="chooseFirst"
          />
          <p v-if="navigation?.scoped" class="mt-2 text-xs text-pretty text-muted">
            You can open only some sections of this app, so some of these may already be on.
          </p>
        </div>
        <div class="max-h-[min(46vh,28rem)] overflow-y-auto px-2 pb-3 sm:px-4">
          <section v-for="group in groups" :key="group.id" :aria-labelledby="`vitehub-add-primitive-${group.id}`">
            <h3 :id="`vitehub-add-primitive-${group.id}`" class="px-2 pb-1 pt-3 text-xs font-medium text-muted">{{ group.label }}</h3>
            <ul class="grid">
              <li v-for="entry in group.primitives" :key="entry.id">
                <button
                  type="button"
                  class="vitehub-add-primitive__row"
                  data-focus-inset
                  @click="choose(entry.id)"
                >
                  <ConsoleSectionIcon :icon="entry.icon" class="size-4 shrink-0 text-muted" />
                  <span class="min-w-0 flex-1">
                    <span class="font-medium text-highlighted">{{ entry.label }}</span>{{ " " }}<span class="text-muted">{{ entry.pitch }}</span>
                  </span>
                  <UKbd v-if="entry.feature" value="CLI" size="sm" title="vitehub add can set it up" />
                </button>
              </li>
            </ul>
          </section>
          <p v-if="!groups.length" class="px-2 py-8 text-center text-sm text-muted">
            {{ addable.length ? `No primitive matches “${query.trim()}”.` : `${appName} uses every primitive that the Console shows.` }}
          </p>
        </div>
      </div>
    </template>

    <template v-if="chosen" #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton color="neutral" variant="ghost" icon="i-lucide-arrow-left" label="Back" @click="choose(undefined)" />
        <UButton color="neutral" variant="outline" trailing-icon="i-lucide-arrow-up-right" label="Docs" :to="chosen.docs" target="_blank" rel="noreferrer" />
      </div>
    </template>
  </UModal>
</template>

<style>
.vitehub-add-primitive__row {
  align-items: flex-start;
  border-radius: var(--ui-radius);
  display: flex;
  font-size: 0.875rem;
  gap: 0.625rem;
  line-height: 1.25rem;
  padding: 0.5rem;
  text-align: start;
  width: 100%;
}

.vitehub-add-primitive__row > :first-child {
  margin-block-start: 0.125rem;
}

.vitehub-add-primitive__row:hover,
.vitehub-add-primitive__row:focus-visible {
  background: var(--ui-bg-elevated);
}
</style>
