<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as v from "valibot";
import {
  envInspectionSchema,
  envMetadataSchema,
  requestEnvManagement,
} from "../client/env-management";
import { ConsoleRequestError } from "../client/request";
import ConsoleEnvActivity from "./console-env-activity.vue";
import ConsoleEnvAccess from "./console-env-access.vue";
const props = defineProps<{ endpoint: string; path: string }>();
const readonly = ref(false);
const inspection = ref<v.InferOutput<typeof envInspectionSchema>>();
const preview = ref<string>();
const value = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const tab = ref("credential");
async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not complete the request.";
  } finally {
    busy.value = false;
  }
}
async function inspect() {
  preview.value = undefined;
  try {
    inspection.value = await requestEnvManagement(
      props.endpoint,
      props.path,
      "inspect",
      envInspectionSchema,
    );
  } catch (cause) {
    if (cause instanceof ConsoleRequestError && cause.status === 404) readonly.value = true;
    else throw cause;
  }
}
function load() {
  return run(inspect);
}
function showPreview() {
  return run(async () => {
    const result = await requestEnvManagement(
      props.endpoint,
      props.path,
      "preview",
      v.object({ metadata: envMetadataSchema }),
    );
    preview.value = result.metadata?.preview;
    if (!preview.value) notice.value = "A masked preview is not available for this credential.";
  });
}
function replace() {
  return run(async () => {
    const result = await requestEnvManagement(
      props.endpoint,
      props.path,
      "replace",
      v.object({ activation: v.picklist(["next-resolution", "restart", "deploy"]) }),
      { value: value.value, expectedRevision: inspection.value?.metadata?.revision ?? null },
    );
    value.value = "";
    await inspect();
    notice.value =
      result.activation === "next-resolution"
        ? "Saved. New resolutions use this value; existing clients keep their loaded value."
        : result.activation === "restart"
          ? "Saved. Restart the application to activate this value."
          : "Saved. Deploy the application to activate this value.";
  });
}
onMounted(load);
</script>

<template>
  <div v-if="!readonly" class="mt-8 space-y-4 border-t border-default pt-5">
    <div v-if="inspection?.admin" class="flex gap-2" aria-label="Credential views">
      <UButton
        v-for="item in [
          { value: 'credential', label: 'Credential' },
          { value: 'activity', label: 'Activity' },
          { value: 'access', label: 'Access' },
        ]"
        :key="item.value"
        :label="item.label"
        color="neutral"
        :variant="tab === item.value ? 'soft' : 'ghost'"
        :aria-pressed="tab === item.value"
        @click="tab = item.value"
      />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
    <template v-if="tab === 'credential'">
      <div class="flex items-center justify-between gap-3">
        <p class="text-sm text-muted">
          {{
            inspection
              ? inspection.metadata
                ? "Stored in provider"
                : "No stored value"
              : busy
                ? "Loading credential…"
                : "Credential unavailable"
          }}
        </p>
        <UButton label="Reload" color="neutral" variant="ghost" :loading="busy" @click="load" />
      </div>
      <p v-if="inspection?.metadata" class="text-xs text-muted">
        Updated {{ new Date(inspection.metadata.updatedAt).toLocaleString() }}
      </p>
      <div v-if="inspection?.permissions.includes('preview')" class="flex items-center gap-3">
        <code v-if="preview" class="break-all text-sm">{{ preview }}</code>
        <UButton
          :label="preview ? 'Hide preview' : 'Show masked preview'"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="preview ? (preview = undefined) : showPreview()"
        />
      </div>
      <form
        v-if="inspection?.permissions.includes('replace')"
        class="space-y-3"
        @submit.prevent="replace"
      >
        <UFormField label="Replace credential" name="credential">
          <UInput
            v-model="value"
            type="password"
            autocomplete="new-password"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <UButton type="submit" label="Save credential" :loading="busy" :disabled="!value" />
      </form>
    </template>
    <ConsoleEnvActivity
      v-else-if="tab === 'activity' && inspection?.admin"
      :endpoint="endpoint"
      :path="path"
    />
    <ConsoleEnvAccess
      v-else-if="tab === 'access' && inspection?.admin"
      :endpoint="endpoint"
      :path="path"
    />
  </div>
</template>
