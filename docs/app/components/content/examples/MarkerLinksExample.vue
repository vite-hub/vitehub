<script setup lang="ts">
const toast = useToast();
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Marker as="a" href="#links-and-buttons">
      <MarkerIcon>
        <UIcon name="i-ph-git-branch-light" />
      </MarkerIcon>
      <MarkerContent>View the pull request</MarkerContent>
    </Marker>
    <Marker
      as="button"
      type="button"
      class="cursor-pointer transition-colors hover:text-highlighted"
      @click="toast.add({ title: 'Reverted the change' })"
    >
      <MarkerIcon>
        <UIcon name="i-ph-arrow-counter-clockwise-light" />
      </MarkerIcon>
      <MarkerContent>Revert this change</MarkerContent>
    </Marker>
  </div>
</template>
