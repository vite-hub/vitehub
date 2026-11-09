<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Message>
      <MessageContent>
        <Bubble variant="muted">
          <BubbleContent>The install failure comes from the workspace package.</BubbleContent>
        </Bubble>
        <MessageFooter>
          <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-copy-light" aria-label="Copy" />
          <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-thumbs-up-light" aria-label="Like" />
          <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-thumbs-down-light" aria-label="Dislike" />
        </MessageFooter>
      </MessageContent>
    </Message>
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Okay, send me a link. I will take a look.</BubbleContent>
        </Bubble>
        <MessageFooter class="gap-2">
          <span class="font-normal text-error">Failed to send</span>
          <UButton color="neutral" variant="ghost" size="xs" square icon="i-ph-arrow-clockwise-light" aria-label="Retry" />
        </MessageFooter>
      </MessageContent>
    </Message>
  </div>
</template>
