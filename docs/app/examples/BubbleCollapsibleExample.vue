<script setup lang="ts">
const text = `The accessibility review found two focus states that are too subtle in dark mode.

I checked the dialog, menu, and drawer because each one shows focusable controls in a layered surface.

The dialog and drawer are fine. The menu needs separate hover and focus tokens, so keyboard focus stays visible when the pointer is not used.

I recommend that you keep the change in the style file, not in the primitive, so other themes can choose their own focus style later.`;

const previewLength = 180;
const open = ref(false);
const contentId = useId();
const isLong = text.length > previewLength;
const preview = `${text.slice(0, previewLength)}...`;
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Bubble variant="muted">
      <BubbleContent>How can I help you today?</BubbleContent>
    </Bubble>
    <Bubble variant="muted" align="end">
      <BubbleContent class="whitespace-pre-line">
        <div :id="contentId">{{ open || !isLong ? text : preview }}</div>
        <UButton
          v-if="isLong"
          color="neutral"
          variant="link"
          size="sm"
          class="px-0 text-muted"
          trailing-icon="i-ph-caret-down-light"
          :ui="{ trailingIcon: open ? 'rotate-180' : '' }"
          :aria-expanded="open"
          :aria-controls="contentId"
          @click="open = !open"
        >
          {{ open ? "Show less" : "Show more" }}
        </UButton>
      </BubbleContent>
    </Bubble>
  </div>
</template>
