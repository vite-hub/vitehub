<script setup lang="ts">
/**
 * A dialog that asks before an action that changes data, such as deleting a key or cancelling a run: a title, one
 * paragraph that says what happens, Cancel, and the action. `destructive` makes the action red and the dialog an
 * `alertdialog`. The default slot replaces the paragraph when the body needs markup, such as a key in code. The width
 * comes from the Console's `modal` app config, like every Console dialog.
 */
withDefaults(
  defineProps<{
    cancelLabel?: string;
    confirmLabel: string;
    description?: string;
    destructive?: boolean;
    /** Disables the action, for example while the dialog still checks what the action affects. */
    disabled?: boolean;
    loading?: boolean;
    title: string;
  }>(),
  { cancelLabel: "Cancel", description: undefined, destructive: false, disabled: false, loading: false },
);
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ confirm: [] }>();
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <UModal v-model:open="open" :title="title" :content="{ role: destructive ? 'alertdialog' : 'dialog' }">
    <template v-if="description || $slots.default" #body>
      <div class="grid gap-3 text-pretty text-[13px] text-muted">
        <slot><p>{{ description }}</p></slot>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" :label="cancelLabel" @click="open = false" />
        <UButton
          :color="destructive ? 'error' : undefined"
          :label="confirmLabel"
          :loading="loading"
          :disabled="disabled"
          @click="emit('confirm')"
        />
      </div>
    </template>
  </UModal>
</template>
