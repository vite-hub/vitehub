<script setup lang="ts">
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from "../bubble/index.ts";
</script>

<template>
  <div data-slot="example-bubble" style="display: flex; flex-direction: column; gap: 1.5rem; max-width: 28rem">
    <BubbleGroup>
      <Bubble align="end">
        <BubbleContent>Ship it on Friday?</BubbleContent>
      </Bubble>
      <Bubble variant="soft">
        <BubbleContent>Friday works. I will tag the release.</BubbleContent>
        <BubbleReactions role="img" aria-label="Reaction: thumbs up">👍</BubbleReactions>
      </Bubble>
      <Bubble variant="soft" tone="info">
        <BubbleContent>
          <template #render="{ props }">
            <button v-bind="props" type="button">Open the release notes</button>
          </template>
        </BubbleContent>
      </Bubble>
    </BubbleGroup>
    <Bubble variant="outline">
      <BubbleContent>An outline bubble for rich content.</BubbleContent>
    </Bubble>
    <Bubble variant="destructive">
      <BubbleContent>Failed: the deploy stopped.</BubbleContent>
    </Bubble>
  </div>
</template>
