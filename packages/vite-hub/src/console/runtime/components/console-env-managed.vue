<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as v from "valibot";
import {
  envInspectionSchema,
  envPermissionSchema,
  envPreviewSchema,
  requestEnvManagement,
} from "../client/env-management";
import { ConsoleRequestError } from "../client/request";
import ConsoleEnvActivity from "./console-env-activity.vue";
import ConsoleEnvAccess from "./console-env-access.vue";
const props = defineProps<{ endpoint: string; path: string }>();
const readonly = ref(false);
const permissionsSchema = v.object({
  permissions: v.array(envPermissionSchema),
  admin: v.boolean(),
});
const access = ref<v.InferOutput<typeof permissionsSchema>>();
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
  inspection.value = undefined;
  inspection.value = await requestEnvManagement(
    props.endpoint,
    props.path,
    "inspect",
    envInspectionSchema,
  );
}
function load() {
  return run(async () => {
    access.value = undefined;
    inspection.value = undefined;
    preview.value = undefined;
    try {
      access.value = await requestEnvManagement(
        props.endpoint,
        props.path,
        "permissions",
        permissionsSchema,
      );
      if (access.value.permissions.includes("inspect")) await inspect();
    } catch (cause) {
      if (cause instanceof ConsoleRequestError && cause.status === 404) readonly.value = true;
      else throw cause;
    }
  });
}
function showPreview() {
  return run(async () => {
    const result = await requestEnvManagement(
      props.endpoint,
      props.path,
      "preview",
      v.object({ metadata: envPreviewSchema }),
    );
    preview.value = result.metadata?.preview;
    if (!preview.value) notice.value = "A masked preview is not available for this credential.";
  });
}
function replace() {
  if (
    !inspection.value ||
    !access.value?.permissions.includes("inspect") ||
    !access.value.permissions.includes("replace")
  )
    return;
  return run(async () => {
    const result = await requestEnvManagement(
      props.endpoint,
      props.path,
      "replace",
      v.object({ activation: v.picklist(["next-resolution", "restart", "deploy"]) }),
      { value: value.value, expectedRevision: inspection.value?.metadata?.revision ?? null },
    );
    value.value = "";
    preview.value = undefined;
    notice.value =
      result.activation === "next-resolution"
        ? "Saved. New resolutions use this value; existing clients keep their loaded value."
        : result.activation === "restart"
          ? "Saved. Restart the application to activate this value."
          : "Saved. Deploy the application to activate this value.";
    try {
      await inspect();
    } catch {
      error.value =
        "Saved, but credential details could not be refreshed. Reload before replacing it again.";
    }
  });
}
onMounted(load);
</script>

<template>
  <p v-if="readonly" class="mt-5 text-sm text-muted">
    This provider is read-only in Console. Manage values in the connected store.
  </p>
  <div v-else class="mt-8 space-y-4 border-t border-default pt-5">
    <div v-if="access?.admin" class="flex gap-2" aria-label="Credential views">
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
                : access && !access.permissions.includes("inspect")
                  ? "Metadata inspection is not available for this identity."
                  : "Credential unavailable"
          }}
        </p>
        <UButton label="Reload" color="neutral" variant="ghost" :loading="busy" @click="load" />
      </div>
      <p v-if="inspection?.metadata" class="text-xs text-muted">
        Updated {{ new Date(inspection.metadata.updatedAt).toLocaleString() }}
      </p>
      <div v-if="access?.permissions.includes('preview')" class="flex items-center gap-3">
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
        v-if="
          inspection &&
          access?.permissions.includes('inspect') &&
          access.permissions.includes('replace')
        "
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
      v-else-if="tab === 'activity' && access?.admin"
      :endpoint="endpoint"
      :path="path"
    />
    <ConsoleEnvAccess
      v-else-if="tab === 'access' && access?.admin"
      :endpoint="endpoint"
      :path="path"
    />
  </div>
</template>
