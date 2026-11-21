<script setup lang="ts">
import { computed } from 'vue'

const { user } = useUserSession()
const name = computed(() => user.value?.name)
</script>

<template>
  <h1>Admin {{ name }}</h1>
</template>
