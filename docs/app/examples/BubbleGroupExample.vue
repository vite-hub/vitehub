<template>
  <div class="flex w-full max-w-sm flex-col gap-8 py-4">
    <Bubble variant="muted">
      <BubbleContent>Can you tell me what the issue is?</BubbleContent>
    </Bubble>
    <BubbleGroup>
      <Bubble align="end">
        <BubbleContent>You tell me!</BubbleContent>
      </Bubble>
      <Bubble align="end">
        <BubbleContent>It worked yesterday. You broke it!</BubbleContent>
      </Bubble>
      <Bubble align="end">
        <BubbleContent>Find the bug and fix it.</BubbleContent>
        <BubbleReactions role="img" aria-label="Reaction: eyes" align="start">
          <span>👀</span>
        </BubbleReactions>
      </Bubble>
    </BubbleGroup>
    <Bubble variant="muted">
      <BubbleContent>
        Do you want me to diff yesterday's commit against today's? It is a bit embarrassing.
      </BubbleContent>
    </Bubble>
  </div>
</template>
