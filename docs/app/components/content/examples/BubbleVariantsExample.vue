<script setup lang="ts">
const answer = `Ghost bubbles work for assistant text, **Markdown**, and other content without a frame.

A ghost bubble can use the full width of the container. You can also show \`code\` in it.`;
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-12 py-4">
    <Bubble>
      <BubbleContent>This is the default primary bubble.</BubbleContent>
    </Bubble>
    <Bubble variant="secondary" align="end">
      <BubbleContent>This is the secondary variant.</BubbleContent>
    </Bubble>
    <Bubble variant="muted">
      <BubbleContent>This one is muted. It uses a lower emphasis color.</BubbleContent>
      <BubbleReactions role="img" aria-label="Reaction: thumbs up">
        <span>👍</span>
      </BubbleReactions>
    </Bubble>
    <Bubble variant="tinted" align="end">
      <BubbleContent>This one is tinted. The tint is a soft color from the primary color.</BubbleContent>
    </Bubble>
    <Bubble variant="outline">
      <BubbleContent>This is the outline variant.</BubbleContent>
    </Bubble>
    <Bubble variant="destructive" align="end">
      <BubbleContent>Failed to run pnpm build. This is the destructive variant.</BubbleContent>
      <BubbleReactions role="img" aria-label="Reaction: fire">
        <span>🔥</span>
      </BubbleReactions>
    </Bubble>
    <Bubble variant="ghost">
      <BubbleContent>
        <Markdown :value="answer" />
      </BubbleContent>
    </Bubble>
  </div>
</template>
