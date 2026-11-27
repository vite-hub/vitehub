<script setup lang="ts">
import { sendQueue } from "vite-hub/queue"

async function send() {
  await sendQueue("click", { at: Date.now() })
}
</script>

<template>
  <button @click="send">Send</button>
</template>
