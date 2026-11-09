<template>
  <div class="flex w-full max-w-sm flex-col gap-8 py-4">
    <Bubble align="end">
      <BubbleContent>The deploy failed. Can you check it?</BubbleContent>
    </Bubble>
    <BubbleGroup>
      <Bubble variant="muted">
        <BubbleContent>Yes. The build stopped at pnpm install.</BubbleContent>
      </Bubble>
      <Bubble variant="muted">
        <BubbleContent>
          The lockfile is out of date, so the frozen install fails. I can update it and run the build again.
        </BubbleContent>
        <BubbleReactions role="img" aria-label="Reaction: thumbs up">
          <span>👍</span>
        </BubbleReactions>
      </Bubble>
    </BubbleGroup>
    <Bubble align="end">
      <BubbleContent>Go ahead.</BubbleContent>
    </Bubble>
    <Bubble variant="muted">
      <BubbleContent>
        Done. I updated pnpm-lock.yaml and the build passes. The preview URL is ready.
      </BubbleContent>
      <BubbleReactions role="img" aria-label="Reactions: thumbs up, fire, eyes, and 2 more">
        <span>👍</span>
        <span>🔥</span>
        <span>👀</span>
        <span>+2</span>
      </BubbleReactions>
    </Bubble>
  </div>
</template>
