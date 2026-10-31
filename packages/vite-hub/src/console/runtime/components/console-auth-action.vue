<script setup lang="ts">
import type {
  AuthConsoleAction,
  AuthConsoleField,
  AuthConsoleMutation,
  AuthConsoleValue,
} from "@vite-hub/auth/console";
import { computed, ref, watch } from "vue";
import { authDuration, changeAuthConsole } from "../client/auth-management";
import { useConsoleToast } from "../client/toast";
const props = defineProps<{
  base: string;
  action?: AuthConsoleAction;
  userId?: string;
  id?: string;
  field?: AuthConsoleField;
  value?: AuthConsoleValue;
  name?: string;
  /** Seconds that an impersonation session lasts. */
  duration?: number;
}>();
const emit = defineEmits<{ close: []; changed: [action: AuthConsoleAction] }>();
const text = ref("");
const expires = ref("");
const checked = ref(false);
const unset = ref(false);
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
    unset.value = false;
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
const toast = useConsoleToast();
/** The toast after an action succeeds. Impersonation opens the app instead, so it has none. */
function doneTitle(action: AuthConsoleAction): string | undefined {
  switch (action) {
    case "ban":
      return "User banned";
    case "unban":
      return "User unbanned";
    case "remove":
      return "User removed";
    case "revokeSession":
      return "Session revoked";
    case "revokeSessions":
      return "Sessions revoked";
    case "revokeConsent":
      return "Client access revoked";
    case "setRole":
      return "Role changed";
    case "editField":
      return `${props.field?.label ?? "Field"} saved`;
    case "impersonate":
      return undefined;
  }
}
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
        if (unset.value && !props.field?.required) value = null;
        else if (props.field?.type === "boolean") value = checked.value;
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
    const done = doneTitle(props.action);
    if (done) toast.show({ title: done });
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
        <ul v-else-if="action === 'impersonate'" class="space-y-3 text-sm text-muted">
          <li class="flex gap-3">
            <UIcon name="i-lucide-log-in" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="text-pretty"
              >This browser signs in to the app as {{ name ?? "this user" }}, and the app opens.
              Your own session comes back when you stop.</span
            >
          </li>
          <li class="flex gap-3">
            <UIcon name="i-lucide-timer" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="text-pretty"
              >The session ends after {{ authDuration(duration ?? 3600) }}. To stop sooner, open
              Auth in the Console.</span
            >
          </li>
          <li class="flex gap-3">
            <UIcon name="i-lucide-history" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="text-pretty">Auth Activity records when you start and when you stop.</span>
          </li>
        </ul>
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
          <USwitch v-if="!field?.required" v-model="unset" label="Unset value" />
          <USelect
            v-if="field?.values"
            v-model="text"
            :disabled="unset"
            :items="field.values"
            class="w-full"
          />
          <USwitch
            v-else-if="field?.type === 'boolean'"
            v-model="checked"
            :disabled="unset"
            :label="field.label"
          />
          <UInput
            v-else
            v-model="text"
            :disabled="unset"
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
