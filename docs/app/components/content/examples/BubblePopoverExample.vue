<template>
  <div class="flex w-full max-w-sm flex-col gap-4 py-4">
    <Bubble align="end">
      <BubbleContent>Run the build script.</BubbleContent>
    </Bubble>
    <Bubble variant="destructive">
      <BubbleContent>Failed to run the command.</BubbleContent>
      <BubbleReactions>
        <UPopover>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            square
            icon="i-ph-info-light"
            aria-label="Show error details"
            class="aria-expanded:text-error"
          />
          <template #content>
            <div class="flex max-w-xs flex-col gap-1 p-3 text-sm">
              <p class="font-medium text-highlighted">Command failed with exit code 1</p>
              <p class="text-muted">ENOENT: no such file or directory, open pnpm-lock.yaml</p>
            </div>
          </template>
        </UPopover>
      </BubbleReactions>
    </Bubble>
  </div>
</template>
