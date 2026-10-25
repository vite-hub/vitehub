<script setup lang="ts">
import type {
  AuthConsoleAction,
  AuthConsoleField,
  AuthConsoleMutation,
  AuthConsoleValue,
} from "@vite-hub/auth/console";
import { computed, ref, watch } from "vue";
import { changeAuthConsole } from "../client/auth-management";
const props = defineProps<{
  base: string;
  action?: AuthConsoleAction;
  userId?: string;
  id?: string;
  field?: AuthConsoleField;
  value?: AuthConsoleValue;
  name?: string;
}>();
const emit = defineEmits<{ close: []; changed: [action: AuthConsoleAction] }>();
const text = ref("");
const expires = ref("");
const checked = ref(false);
const error = ref("");
const pending = ref(false);
const labels: Record<AuthConsoleAction, string> = {
  ban: "Ban user",
  unban: "Unban user",
  remove: "Remove user",
  revokeSession: "Revoke session",
  revokeSessions: "Revoke all sessions",
  setRole: "Set role",
  editField: "Edit field",
  impersonate: "Impersonate user",
  revokeConsent: "Revoke client access",
};
const destructive = computed(() =>
  ["remove", "ban", "revokeSession", "revokeSessions", "revokeConsent"].includes(
    props.action ?? "",
  ),
);
const title = computed(() =>
  props.action === "editField"
    ? `Edit ${props.field?.label ?? "field"}`
    : props.action
      ? labels[props.action]
      : "Auth action",
);
const open = computed({
  get: () => Boolean(props.action),
  set: (value: boolean) => {
    if (!value && !pending.value) emit("close");
  },
});
watch(
  () => [props.action, props.field?.key, props.userId, props.id],
  () => {
    error.value = "";
    expires.value = "";
    checked.value = props.value === true;
    text.value = Array.isArray(props.value)
      ? JSON.stringify(props.value)
      : props.value === null || props.value === undefined
        ? ""
        : String(props.value);
  },
);
async function submit() {
  if (!props.action) return;
  pending.value = true;
  error.value = "";
  try {
    let body: AuthConsoleMutation;
    switch (props.action) {
      case "ban":
        body = {
          action: "ban",
          userId: props.userId!,
          reason: text.value || undefined,
          expiresIn: expires.value ? Number(expires.value) * 86400 : undefined,
        };
        break;
      case "setRole":
        body = { action: "setRole", userId: props.userId!, role: text.value };
        break;
      case "editField": {
        let value: AuthConsoleValue = text.value;
        if (props.field?.type === "boolean") value = checked.value;
        else if (props.field?.type === "number") {
          if (!text.value.trim()) throw new Error("Enter a number.");
          value = Number(text.value);
        } else if (props.field?.type.endsWith("[]")) value = JSON.parse(text.value);
        body = { action: "editField", userId: props.userId!, field: props.field!.key, value };
        break;
      }
      case "revokeSession":
      case "revokeConsent":
        body = { action: props.action, id: props.id! };
        break;
      default:
        body = { action: props.action, userId: props.userId! };
    }
    await changeAuthConsole(props.base, body);
    emit("changed", props.action);
    emit("close");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The action failed.";
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="name ? `${title} for ${name}.` : title"
    :content="{ role: destructive ? 'alertdialog' : 'dialog' }"
    :dismissible="!pending && !destructive"
    :close="!pending && !destructive"
  >
    <template #body>
      <form class="space-y-4" @submit.prevent="submit">
        <p v-if="action === 'remove'" class="text-sm text-muted">
          This permanently removes the user and their Auth data.
        </p>
        <p v-else-if="action === 'impersonate'" class="text-sm text-muted">
          This browser will use the user's session. The app will open after the change.
        </p>
        <p
          v-else-if="action === 'revokeSession' || action === 'revokeSessions'"
          class="text-sm text-muted"
        >
          The affected sessions will end. The user must sign in again.
        </p>
        <UFormField v-if="action === 'ban'" label="Reason"
          ><UInput v-model="text" class="w-full" maxlength="1000"
        /></UFormField>
        <UFormField
          v-if="action === 'ban'"
          label="Expires in days"
          help="Leave empty for no expiry."
          ><UInput v-model="expires" type="number" min="1"
        /></UFormField>
        <UFormField v-if="action === 'setRole'" label="Role" required
          ><UInput v-model="text" required class="w-full"
        /></UFormField>
        <UFormField v-if="action === 'editField'" :label="field?.label" :required="field?.required">
          <USelect v-if="field?.values" v-model="text" :items="field.values" class="w-full" />
          <USwitch v-else-if="field?.type === 'boolean'" v-model="checked" :label="field.label" />
          <UInput
            v-else
            v-model="text"
            :type="field?.type === 'number' ? 'number' : 'text'"
            :placeholder="field?.type === 'date' ? '2026-10-25T12:00:00Z' : undefined"
            :required="field?.required"
            class="w-full"
          />
        </UFormField>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="pending" @click="emit('close')"
            >Cancel</UButton
          ><UButton
            type="submit"
            :color="action === 'remove' || action === 'ban' ? 'error' : 'primary'"
            :disabled="pending"
            >{{ pending ? "Working…" : title }}</UButton
          >
        </div>
      </form>
    </template>
  </UModal>
</template>
