<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { showcasePhaseIds, type ExampleFile, type ShowcasePhaseId } from "~~/modules/vitehub-docs/runtime/utils/showcase";

const props = defineProps<{
  docsPath: string;
}>();

const { example, framework, mode, phases, files } = useShowcaseExamples(() => props.docsPath);

const phaseEntries = computed(() => {
  return showcasePhaseIds
    .map((phase) => {
      const path = phases.value[phase];
      if (!path) {
        return null;
      }

      return { phase, path };
    })
    .filter((entry): entry is { phase: ShowcasePhaseId; path: string } => Boolean(entry));
});

const phaseByPath = computed(() => {
  return new Map(phaseEntries.value.map(entry => [entry.path, entry.phase]));
});

const activeFilePath = ref("");

watch(
  [files, phaseEntries],
  () => {
    if (files.value.some(file => file.path === activeFilePath.value)) {
      return;
    }

    activeFilePath.value = phaseEntries.value[0]?.path || files.value[0]?.path || "";
  },
  { immediate: true },
);

const activeFile = computed<ExampleFile | null>(() => {
  return files.value.find(file => file.path === activeFilePath.value) || files.value[0] || null;
});

const activePhase = computed(() => {
  if (!activeFile.value) {
    return null;
  }

  return phaseByPath.value.get(activeFile.value.path) || null;
});

const { data: highlightedCode } = useHighlightedCode(
  () => activeFile.value?.path || "example",
  () => activeFile.value?.code || "",
);
</script>

<template>
  <UCard v-if="example" class="not-prose my-8 overflow-hidden">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm font-semibold text-highlighted">
            Examples
          </div>
          <div class="text-sm text-muted">
            Current selection: {{ framework }} / {{ mode }}
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <UBadge color="neutral" variant="soft">
            {{ example.label }}
          </UBadge>
          <UBadge color="primary" variant="soft">
            {{ framework }}
          </UBadge>
          <UBadge color="neutral" variant="subtle">
            {{ mode }}
          </UBadge>
        </div>
      </div>
    </template>

    <div class="grid gap-0 lg:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)]">
      <div class="border-default lg:border-r">
        <div class="border-b border-default px-4 py-3">
          <div class="text-xs font-medium tracking-wide text-muted uppercase">
            Phase files
          </div>
        </div>
        <div class="space-y-2 p-3">
          <button
            v-for="entry in phaseEntries"
            :key="entry.phase"
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors"
            :class="activeFilePath === entry.path ? 'border-primary/40 bg-primary/5' : 'border-default hover:bg-muted/30'"
            @click="activeFilePath = entry.path"
          >
            <span class="text-xs font-medium uppercase text-muted">{{ entry.phase }}</span>
            <code class="min-w-0 truncate text-sm">{{ entry.path }}</code>
          </button>
        </div>

        <div class="border-y border-default px-4 py-3 text-xs font-medium tracking-wide text-muted uppercase lg:border-b-0">
          Files
        </div>
        <div class="space-y-1.5 p-3">
          <button
            v-for="file in files"
            :key="file.path"
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors"
            :class="activeFilePath === file.path ? 'border-primary/40 bg-primary/5' : phaseByPath.has(file.path) ? 'border-primary/20' : 'border-default hover:bg-muted/30'"
            @click="activeFilePath = file.path"
          >
            <code class="min-w-0 truncate text-sm">{{ file.path }}</code>
            <UBadge
              v-if="phaseByPath.has(file.path)"
              color="primary"
              variant="soft"
              class="uppercase"
            >
              {{ phaseByPath.get(file.path) }}
            </UBadge>
          </button>
        </div>
      </div>

      <div class="min-w-0">
        <div class="flex items-center justify-between gap-3 border-b border-default px-4 py-3">
          <div class="flex min-w-0 items-center gap-2">
            <UIcon name="i-lucide-file-code-2" class="size-4 shrink-0 text-muted" />
            <code class="truncate text-sm text-highlighted">{{ activeFile?.path }}</code>
          </div>
          <UBadge v-if="activePhase" color="primary" variant="soft" class="uppercase">
            {{ activePhase }}
          </UBadge>
        </div>

        <div class="overflow-x-auto bg-muted/20">
          <div
            v-if="highlightedCode"
            class="[&_.shiki]:!m-0 [&_.shiki]:min-h-[28rem] [&_.shiki]:overflow-x-auto [&_.shiki]:rounded-none [&_.shiki]:border-0 [&_.shiki]:bg-transparent [&_.shiki]:p-4 [&_.shiki]:text-sm"
            v-html="highlightedCode"
          />
          <pre v-else class="min-h-[28rem] overflow-x-auto p-4 text-sm text-toned"><code>{{ activeFile?.code }}</code></pre>
        </div>
      </div>
    </div>
  </UCard>

  <UAlert
    v-else
    class="not-prose my-8"
    color="warning"
    variant="soft"
    title="Missing showcase manifest"
    :description="`No showcase entry was found for ${props.docsPath}.`"
  />
</template>
