<script setup lang="ts">
const toast = useToast();
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-12 py-4">
    <Bubble variant="muted" align="end">
      <BubbleContent>I don't need tests. I know my code works.</BubbleContent>
      <BubbleReactions align="start" role="img" aria-label="Reactions: thumbs up, surprised">
        <span>👍</span>
        <span>😮</span>
      </BubbleReactions>
    </Bubble>
    <Bubble variant="muted">
      <BubbleContent>Bold. I will add some tests and tell you when they are done.</BubbleContent>
      <BubbleReactions role="img" aria-label="Reactions: eyes, rocket, and 2 more">
        <span>👀</span>
        <span>🚀</span>
        <span>+2</span>
      </BubbleReactions>
    </Bubble>
    <Bubble align="end">
      <BubbleContent>All 142 tests passed on the first try. Looks good!</BubbleContent>
      <BubbleReactions side="top" align="start" role="img" aria-label="Reactions: party popper, clapping hands">
        <span>🎉</span>
        <span>👏</span>
      </BubbleReactions>
    </Bubble>
    <Bubble variant="destructive">
      <BubbleContent>Can I run rm -rf node_modules?</BubbleContent>
      <BubbleReactions>
        <UButton color="neutral" variant="ghost" size="xs" @click="toast.add({ title: 'Running rm -rf node_modules' })">
          Yes, run it
        </UButton>
      </BubbleReactions>
    </Bubble>
  </div>
</template>
