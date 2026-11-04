<!-- A runnable tutorial uses the viewport under the site header: the lesson on the left, the workspace on the right. -->
<template>
  <UMain class="vh-tutorial-layout">
    <slot />
  </UMain>
</template>

<style scoped>
.vh-tutorial-layout {
  min-height: calc(100dvh - var(--ui-header-height));
}
</style>
