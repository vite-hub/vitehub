<template>
  <div class="flex w-full max-w-sm flex-col gap-4 py-4">
    <Bubble variant="secondary">
      <BubbleContent>Did you remove the stale route?</BubbleContent>
    </Bubble>
    <Bubble align="end">
      <BubbleContent>Yes, I removed it from the registry.</BubbleContent>
      <BubbleReactions>
        <UTooltip text="Read on Jan 5, 2026 at 4:32 PM">
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            square
            icon="i-ph-check-light"
            aria-label="Read on Jan 5, 2026 at 4:32 PM"
          />
        </UTooltip>
      </BubbleReactions>
    </Bubble>
  </div>
</template>
