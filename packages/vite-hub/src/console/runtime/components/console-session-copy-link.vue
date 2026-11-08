<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

const linkCopy = ref<"copied" | "failed">();
let linkCopyTimer: ReturnType<typeof setTimeout> | undefined;
const label = computed(() =>
  linkCopy.value === "copied" ? "Link copied" : linkCopy.value === "failed" ? "Could not copy link" : "Copy session link",
);

async function copySessionLink(): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(window.location.href);
    linkCopy.value = "copied";
  } catch {
    linkCopy.value = "failed";
  }
  if (linkCopyTimer) clearTimeout(linkCopyTimer);
  linkCopyTimer = setTimeout(() => (linkCopy.value = undefined), 2_000);
}

onBeforeUnmount(() => {
  if (linkCopyTimer) clearTimeout(linkCopyTimer);
});
</script>

<template>
  <span class="sr-only" role="status" aria-live="polite">{{ linkCopy ? label : "" }}</span>
  <UTooltip :text="label">
    <UButton
      :icon="linkCopy === 'copied' ? 'i-lucide-check' : 'i-lucide-link'"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="label"
      @click="copySessionLink"
    />
  </UTooltip>
</template>
