<script setup lang="ts">
const variants = ["default", "secondary", "muted", "tinted", "outline", "ghost", "destructive"] as const;
</script>

<template>
  <BubbleGroup class="w-full max-w-lg">
    <Bubble v-for="variant in variants" :key="variant" :variant="variant" :align="variant === 'default' ? 'end' : 'start'">
      <BubbleContent>{{ variant }} bubble</BubbleContent>
    </Bubble>
    <Bubble variant="outline" class="mb-3">
      <BubbleContent as="a" href="#links-and-buttons">
        A bubble rendered as a link
      </BubbleContent>
      <BubbleReactions>👍 2</BubbleReactions>
    </Bubble>
  </BubbleGroup>
</template>
