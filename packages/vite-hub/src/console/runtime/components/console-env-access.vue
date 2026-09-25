<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as v from "valibot";
import { envGrantsSchema, requestEnvManagement } from "../client/env-management";
const props = defineProps<{ endpoint: string; path: string }>();
type Grant = v.InferOutput<typeof envGrantsSchema>["grants"][number];
const grants = ref<Grant[]>([]);
const kind = ref<Grant["actor"]["kind"]>("agent");
const id = ref("");
const permissions = ref<Array<Grant["permissions"][number]>>(["use"]);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const removing = ref<string>();
async function load() {
  grants.value = (
    await requestEnvManagement(props.endpoint, props.path, "grants", envGrantsSchema)
  ).grants;
}
async function run(operation: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await operation();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not update access.";
  } finally {
    busy.value = false;
  }
}
async function refreshAfterUpdate(action: "saved" | "revoked") {
  notice.value = action === "saved" ? "Access saved." : "Access revoked.";
  try {
    await load();
  } catch {
    error.value = `Access ${action}, but the grant list could not be refreshed. Reload to confirm current access.`;
  }
}
function grant() {
  return run(async () => {
    await requestEnvManagement(props.endpoint, props.path, "grant", v.object({ ok: v.boolean() }), {
      actor: { kind: kind.value, id: id.value.trim() },
      permissions: permissions.value,
    });
    id.value = "";
    await refreshAfterUpdate("saved");
  });
}
function revoke(actor: Grant["actor"]) {
  return run(async () => {
    await requestEnvManagement(
      props.endpoint,
      props.path,
      "revoke",
      v.object({ ok: v.boolean() }),
      { actor },
    );
    removing.value = undefined;
    grants.value = grants.value.filter(
      (item) => item.actor.kind !== actor.kind || item.actor.id !== actor.id,
    );
    await refreshAfterUpdate("revoked");
  });
}
onMounted(() => run(load));
</script>
<template>
  <div class="space-y-5">
    <p class="text-xs text-muted">
      Grants apply only to this credential. Agent tokens may further limit access.
    </p>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
    <ul role="list" class="divide-y divide-default">
      <li
        v-for="item in grants"
        :key="`${item.actor.kind}:${item.actor.id}`"
        class="flex items-start justify-between gap-3 py-3"
      >
        <div class="min-w-0 text-xs">
          <p class="break-all text-highlighted">{{ item.actor.id }}</p>
          <p class="text-muted">{{ item.actor.kind }} · {{ item.permissions.join(", ") }}</p>
        </div>
        <div v-if="removing === `${item.actor.kind}:${item.actor.id}`" class="flex shrink-0 gap-1">
          <UButton
            label="Revoke"
            color="error"
            variant="soft"
            size="xs"
            :loading="busy"
            @click="revoke(item.actor)"
          /><UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="removing = undefined"
          />
        </div>
        <UButton
          v-else
          label="Remove"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="busy"
          @click="removing = `${item.actor.kind}:${item.actor.id}`"
        />
      </li>
    </ul>
    <p v-if="!grants.length && !busy && !error" class="text-sm text-muted">No explicit grants.</p>
    <form class="space-y-3" @submit.prevent="grant">
      <UFormField label="Identity" name="identity"
        ><div class="flex gap-2">
          <USelect
            v-model="kind"
            :items="['agent', 'user', 'service']"
            aria-label="Identity type"
          /><UInput
            v-model="id"
            placeholder="Identity ID"
            class="min-w-0 flex-1"
            required
            :disabled="busy"
          /></div
      ></UFormField>
      <UFormField label="Permissions" name="permissions"
        ><UCheckboxGroup
          v-model="permissions"
          :items="[
            { value: 'inspect', label: 'Inspect metadata' },
            { value: 'preview', label: 'View masked preview' },
            { value: 'replace', label: 'Replace credential' },
            { value: 'use', label: 'Use credential' },
          ]"
          :disabled="busy"
      /></UFormField>
      <UButton
        type="submit"
        label="Save access"
        :loading="busy"
        :disabled="!id.trim() || !permissions.length"
      />
    </form>
  </div>
</template>
