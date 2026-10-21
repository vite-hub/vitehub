<script setup lang="ts">
const toast = useToast();
const choices = ["Fix the failing test", "Explain the last deploy", "Something else. Talk to a human."];
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Bubble variant="muted">
      <BubbleContent>How can I help you today?</BubbleContent>
    </Bubble>
    <BubbleGroup>
      <Bubble v-for="choice in choices" :key="choice" variant="tinted" align="end">
        <BubbleContent as="button" type="button" @click="toast.add({ title: `You chose: ${choice}` })">
          {{ choice }}
        </BubbleContent>
      </Bubble>
    </BubbleGroup>
  </div>
</template>
