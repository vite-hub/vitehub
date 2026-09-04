<script setup lang="ts">
import { AgentChatPrompt } from "@vite-hub/ui";
import { computed, ref, watch } from "vue";

import { requestConsole } from "../client/request";

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

function rejectFiles(): [] {
  return [];
}

async function submit(message: { text: string }): Promise<void> {
  if (loading.value || !message.text.trim()) return;
  loading.value = true;
  error.value = undefined;
  try {
    const response = await requestConsole(
      `${props.base}/${encodeURIComponent(props.agent)}/invocations`,
      {
        body: {
          prompt: message.text,
          ...(selectedProfileId.value ? { invokerProfileId: selectedProfileId.value } : {}),
        },
        method: "POST",
      },
    );
    const result =
      response instanceof Object && !Array.isArray(response)
        ? Object.fromEntries(Object.entries(response))
        : undefined;
    const id = typeof result?.id === "string" ? result.id : undefined;
    if (!id) throw new Error("The Agent invocation response did not include an id.");
    draft.value = "";
    emit("started", { agent: props.agent, id });
  } catch (value) {
    error.value = value;
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
            <span class="truncate">Agent {{ agent }}</span>
          </span>
          <span class="ml-auto shrink-0 font-mono text-[11px]">New invocation</span>
        </div>

        <div class="console-invocation-composer__surface relative z-10 rounded-[22px] bg-default ring-1 ring-default shadow-sm transition-shadow has-[textarea:focus-visible]:ring-accented">
          <AgentChatPrompt
            v-model="draft"
            aria-label="Test this Agent"
            class="console-invocation-composer__prompt min-h-32 gap-3 rounded-[22px] bg-default px-4 pb-3 pt-4 [&_.vh-prompt__spacer]:hidden"
            color="neutral"
            :filter-files="rejectFiles"
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
            <template #actions>
              <div class="mr-auto flex min-w-0 items-center gap-2 text-sm text-muted">
                <UIcon class="size-4 shrink-0" name="i-ph-robot-light" />
                <span v-if="profiles.length <= 1" class="truncate">{{ profiles[0]?.label || agent }}</span>
                <USelect
                  v-else
                  v-model="selectedProfileId"
                  aria-label="Invoker profile"
                  class="max-w-52"
                  :items="profileItems"
                  size="sm"
                  variant="ghost"
                />
              </div>
            </template>
            <template #submit>
              <UButton
                aria-label="Start Agent"
                class="console-invocation-composer__submit size-8 rounded-full active:scale-[0.97]"
                color="primary"
                icon="i-ph-arrow-up-light"
                :disabled="!draft.trim() || loading"
                :loading="loading"
                square
                size="sm"
                type="button"
                @click="submit({ text: draft })"
              />
            </template>
          </AgentChatPrompt>
        </div>
      </div>
    </div>
  </div>
</template>
