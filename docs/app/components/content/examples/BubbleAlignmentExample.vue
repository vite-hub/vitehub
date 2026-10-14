<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Bubble variant="muted">
      <BubbleContent>This bubble aligns to the start. This is the default alignment.</BubbleContent>
    </Bubble>
    <Bubble align="end">
      <BubbleContent>This bubble aligns to the end. Use it for user messages.</BubbleContent>
    </Bubble>
  </div>
</template>
