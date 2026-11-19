<script setup lang="ts">
const route = useRoute()
const { data: post } = await useAsyncData(route.path, () => queryCollection('blog').path(route.path).first())
</script>

<template>
  <ContentRenderer v-if="post" :value="post" />
</template>
