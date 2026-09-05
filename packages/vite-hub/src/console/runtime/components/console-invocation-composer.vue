<script setup lang="ts">
import { AgentChatPrompt } from "@vite-hub/ui";
import type { FileUIPart } from "ai";
import { computed, ref, watch } from "vue";

import { startConsoleAgentInvocation } from "../client/invocation";

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
  const agent = props.agent;
  const base = props.base;
  try {
    const started = await startConsoleAgentInvocation({ agent, base, invokerProfileId: selectedProfileId.value }, message);
    if (props.agent === agent && props.base === base) {
      draft.value = "";
      files.value = [];
      emit("started", started);
    }
  } catch (value) {
    if (props.agent === agent && props.base === base) error.value = value;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div
    class="console-invocation-composer shrink-0 bg-default px-3 pb-5 pt-3 sm:px-5 sm:pb-6"
  >
    <div class="mx-auto grid w-full max-w-3xl gap-2">
      <UAlert
        v-if="error"
        color="error"
        icon="i-ph-warning-circle-light"
        title="Could not start Agent"
        :description="errorMessage(error)"
        variant="subtle"
      />
      <div class="relative pb-9">
        <div
          aria-label="Invocation context"
          class="console-invocation-composer__context absolute inset-x-[22px] bottom-0 flex h-12 items-end gap-3 overflow-hidden rounded-b-2xl bg-elevated/60 px-4 pb-2 text-xs text-muted ring-1 ring-default"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <UIcon class="size-4 shrink-0" name="i-ph-folder-light" />
            <span class="truncate">ViteHub Console</span>
          </span>
          <span class="h-4 w-px shrink-0 bg-default" />
          <span class="flex min-w-0 items-center gap-1.5">
            <UIcon class="size-4 shrink-0" name="i-ph-robot-light" />
            <span v-if="profiles.length <= 1" class="truncate">{{ profiles[0]?.label || agent }}</span>
            <USelect v-else v-model="selectedProfileId" aria-label="Invoker profile" :items="profileItems" size="sm" variant="ghost" />
          </span>
          <span class="ml-auto shrink-0 font-mono text-[11px]">New invocation</span>
        </div>

        <div class="console-invocation-composer__surface relative z-10 rounded-[22px] bg-default ring-1 ring-default shadow-sm transition-shadow has-[textarea:focus-visible]:ring-accented">
          <AgentChatPrompt
            v-model="draft"
            v-model:files="files"
            aria-label="Test this Agent"
            accept="image/png,image/jpeg,image/webp,image/gif"
            @error="error = $event"
            class="console-invocation-composer__prompt min-h-32 gap-3 rounded-[22px] bg-default px-4 pb-3 pt-4 [&_.vh-prompt__spacer]:hidden"
            color="neutral"
            :filter-files="filterFiles"
            :maxrows="8"
            placeholder="Test this Agent..."
            :rows="3"
            :status="loading ? 'submitted' : 'ready'"
            variant="naked"
            :ui="{
              body: 'min-h-14 items-start text-base leading-6',
              footer: 'min-h-8 gap-2',
            }"
            @submit="submit"
          >
            <template #submit="{ canSubmit }">
              <UButton
                aria-label="Start Agent"
                class="console-invocation-composer__submit size-8 rounded-full active:scale-[0.97]"
                color="primary"
                icon="i-ph-arrow-up-light"
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
      </div>
    </div>
  </div>
</template>
