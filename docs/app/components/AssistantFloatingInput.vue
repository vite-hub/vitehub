<script setup lang="ts">
const route = useRoute();
const appConfig = useAppConfig();
const { isEnabled, isOpen, open } = useAssistant();

const isVisible = computed(() => {
  return isEnabled.value
    && appConfig.assistant?.floatingInput !== false
    && route.meta.layout === "docs"
    && !isOpen.value;
});
</script>

<template>
  <div
    v-if="isVisible"
    class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-20 hidden sm:block"
  >
    <UButton
      label="Ask AI"
      color="neutral"
      variant="soft"
      size="sm"
      class="rounded-none border border-default bg-default shadow-lg"
      @click="open()"
    >
      <template #trailing>
        <span class="hidden items-center gap-0.5 sm:flex">
          <UKbd value="meta" />
          <UKbd value="I" />
        </span>
      </template>
    </UButton>
  </div>
</template>
