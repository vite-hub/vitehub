<script setup lang="ts">
import { AgentChatPrompt } from "@vite-hub/ui";
import type { FileUIPart } from "ai";
import { computed, ref, watch } from "vue";

import { startConsoleAgentInvocation, useConsoleInvocationTarget } from "../client/invocation";
import { ConsoleRequestError } from "../client/request";
import ConsoleState from "./console-state.vue";

interface ConsoleAgentProfile {
  id: string;
  label?: string;
}

const props = defineProps<{
  agent: string;
  base: string;
  profiles: ConsoleAgentProfile[];
}>();

const emit = defineEmits<{
  started: [invocation: { agent: string; id: string }];
}>();

const draft = ref("");
const files = ref<FileUIPart[]>([]);
const error = ref<unknown>();
const loading = ref(false);
const selectedProfileId = ref<string>();
const captureTarget = useConsoleInvocationTarget(() => ({
  agent: props.agent,
  base: props.base,
  invokerProfileId: selectedProfileId.value,
}));
const profileItems = computed(() =>
  props.profiles.map((profile) => ({ label: profile.label || profile.id, value: profile.id })),
);

watch(
  () => [props.agent, ...props.profiles.map((profile) => profile.id)],
  () => {
    if (!props.profiles.some((profile) => profile.id === selectedProfileId.value)) {
      selectedProfileId.value = props.profiles[0]?.id;
    }
  },
  { immediate: true },
);

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The Agent invocation could not be started.";
}

function filterFiles(selected: readonly File[]): readonly File[] {
  const accepted = selected.filter(file => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type));
  if (accepted.length !== selected.length) error.value = new Error("Use a PNG, JPEG, WebP, or GIF image. Other files are not supported by this Console input yet.");
  if (accepted.some(file => file.size > 10 * 1024 * 1024)) {
    error.value = new Error("Images must be at most 10 MiB.");
  }
  return accepted.filter(file => file.size <= 10 * 1024 * 1024);
}

async function submit(message: { text: string; files?: readonly FileUIPart[] }): Promise<void> {
  if (loading.value || (!message.text.trim() && !message.files?.length)) return;
  loading.value = true;
  error.value = undefined;
  const { target, isCurrent } = captureTarget();
  try {
    const started = await startConsoleAgentInvocation(target, message);
    if (isCurrent()) {
      draft.value = "";
      files.value = [];
      emit("started", started);
    }
  } catch (value) {
    if (isCurrent()) error.value = value;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="console-invocation-composer shrink-0 bg-default px-3 pb-4 pt-2 sm:px-5 sm:pb-5">
    <div class="mx-auto grid w-full max-w-3xl gap-2">
      <ConsoleState
        v-if="error instanceof ConsoleRequestError"
        compact
        :error="error"
        title="Could not start Agent"
      />
      <UAlert
        v-else-if="error"
        color="error"
        icon="i-ph-warning-circle-light"
        title="Could not start Agent"
        :description="errorMessage(error)"
        variant="subtle"
      />
      <div
        class="console-invocation-composer__surface relative rounded-[22px] bg-default ring-1 ring-default transition-shadow has-[textarea:focus-visible]:ring-accented"
      >
        <AgentChatPrompt
          v-model="draft"
          v-model:files="files"
          aria-label="Test this Agent"
          accept="image/png,image/jpeg,image/webp,image/gif"
          @error="error = $event"
          class="console-invocation-composer__prompt gap-2 rounded-[22px] bg-transparent px-3 pb-2 pt-3 sm:px-4 sm:pt-3.5 [&_.vh-prompt__spacer]:hidden"
          color="neutral"
          :filter-files="filterFiles"
          :maxrows="8"
          :placeholder="`Message ${agent}…`"
          :rows="2"
          :status="loading ? 'submitted' : 'ready'"
          variant="naked"
          :ui="{
            body: 'min-h-[4.375rem] items-start text-sm leading-relaxed',
            footer: 'min-h-8 items-center gap-2',
          }"
          @submit="submit"
        >
          <template #footer-leading>
            <div class="console-invocation-composer__context flex min-w-0 items-center gap-0.5 text-xs text-muted">
              <span class="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2">
                <UIcon class="size-4 shrink-0 opacity-70" name="i-ph-robot-light" />
                <span class="truncate">{{ agent }}</span>
              </span>
              <template v-if="profiles.length > 1">
                <span class="mx-0.5 h-4 w-px shrink-0 bg-default" aria-hidden="true" />
                <USelect
                  v-model="selectedProfileId"
                  aria-label="Invoker profile"
                  :items="profileItems"
                  size="xs"
                  variant="ghost"
                  :ui="{ base: 'h-7 rounded-lg px-2 text-xs text-muted hover:text-default' }"
                />
              </template>
              <template v-else-if="profiles[0]?.label">
                <span class="mx-0.5 h-4 w-px shrink-0 bg-default" aria-hidden="true" />
                <span class="flex h-7 items-center truncate px-2">{{ profiles[0].label }}</span>
              </template>
            </div>
          </template>
          <template #submit="{ canSubmit }">
            <UButton
              aria-label="Start Agent"
              class="console-invocation-composer__submit size-8 rounded-full transition-transform hover:scale-105 disabled:opacity-30 active:scale-[0.97]"
              color="primary"
              icon="i-ph-arrow-up-bold"
              :disabled="!canSubmit"
              :loading="loading"
              square
              size="sm"
              type="button"
              @click="submit({ text: draft, files })"
            />
          </template>
        </AgentChatPrompt>
      </div>
      <p class="px-3 text-center text-[11px] text-dimmed">
        Enter sends · Shift+Enter adds a line · Images up to 10 MiB
      </p>
    </div>
  </div>
</template>
