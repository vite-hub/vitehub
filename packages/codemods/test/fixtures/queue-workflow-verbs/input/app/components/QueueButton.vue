<script setup lang="ts">
import { runQueue } from "vite-hub/queue"

async function send() {
  await runQueue("click", { at: Date.now() })
}
</script>

<template>
  <button @click="send">Send</button>
</template>
