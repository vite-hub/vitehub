<script setup lang="ts">
import { Button } from "@vite-hub/kit/button"
import { useLog } from "../log"

const log = useLog()
</script>

<template>
  <Button @click="log('Pressed')">Button</Button>
</template>
