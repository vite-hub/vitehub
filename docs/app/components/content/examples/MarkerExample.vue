<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Marker>
      <MarkerIcon>
        <UIcon name="i-ph-git-branch-light" />
      </MarkerIcon>
      <MarkerContent>Switched to fix/frozen-lockfile</MarkerContent>
    </Marker>
    <Marker role="status">
      <MarkerIcon>
        <UIcon name="i-ph-circle-dashed-light" />
      </MarkerIcon>
      <MarkerContent>Thinking...</MarkerContent>
    </Marker>
    <Marker variant="separator">
      <MarkerContent>Conversation compacted</MarkerContent>
    </Marker>
    <Marker>
      <MarkerIcon>
        <UIcon name="i-ph-magnifying-glass-light" />
      </MarkerIcon>
      <MarkerContent>Explored 4 files</MarkerContent>
    </Marker>
  </div>
</template>
