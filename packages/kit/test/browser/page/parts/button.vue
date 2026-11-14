<script setup lang="ts">
import { Button } from "@ui-sdk/vue/button"
import { useLog } from "../log"

const log = useLog()
</script>

<template>
  <Button @click="log('Pressed')">Button</Button>
</template>
