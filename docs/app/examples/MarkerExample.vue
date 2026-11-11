<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Marker>
      <MarkerIcon>
        <UIcon name="i-lucide-git-branch" />
      </MarkerIcon>
      <MarkerContent>Switched to fix/frozen-lockfile</MarkerContent>
    </Marker>
    <Marker role="status">
      <MarkerIcon>
        <UIcon name="i-lucide-circle-dashed" />
      </MarkerIcon>
      <MarkerContent>Thinking...</MarkerContent>
    </Marker>
    <Marker variant="separator">
      <MarkerContent>Conversation compacted</MarkerContent>
    </Marker>
    <Marker>
      <MarkerIcon>
        <UIcon name="i-lucide-search" />
      </MarkerIcon>
      <MarkerContent>Explored 4 files</MarkerContent>
    </Marker>
  </div>
</template>
