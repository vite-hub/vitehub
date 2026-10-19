<template>
  <div class="flex w-full max-w-lg flex-col gap-4">
    <Marker variant="separator">
      <MarkerContent>Today</MarkerContent>
    </Marker>
    <Marker>
      <MarkerIcon>
        <UIcon name="i-ph-git-branch-light" />
      </MarkerIcon>
      <MarkerContent>Switched to <code>fix/frozen-lockfile</code></MarkerContent>
    </Marker>
    <Marker variant="border">
      <MarkerContent>Context compacted. <a href="#usage">See the summary</a></MarkerContent>
    </Marker>
  </div>
</template>
