<!-- The panel head holds only search. The rail marks the current product, and the page list starts with its Overview. -->
<template>
  <div class="vh-sidebar-head">
    <UContentSearchButton
      :collapsed="false"
      class="vh-sidebar-search"
      :ui="{
        base: 'h-10 rounded-none border-0 border-b border-default bg-muted/20 ps-5 pe-5 text-muted hover:bg-muted/40 hover:text-highlighted',
        // Touch screens have no keyboard shortcut to show.
        trailing: 'ms-auto flex items-center gap-1 pointer-coarse:hidden',
      }"
    />
  </div>
</template>

<style scoped>
.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}
</style>
