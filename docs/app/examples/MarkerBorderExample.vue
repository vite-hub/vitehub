<template>
  <div class="flex w-full max-w-sm flex-col gap-3">
    <Marker variant="border">
      <MarkerIcon>
        <UIcon name="i-lucide-git-branch" />
      </MarkerIcon>
      <MarkerContent>Switched to release-candidate</MarkerContent>
    </Marker>
    <Marker variant="border">
      <MarkerIcon>
        <UIcon name="i-lucide-search" />
      </MarkerIcon>
      <MarkerContent>Reviewed 8 related files</MarkerContent>
    </Marker>
    <Marker variant="border">
      <MarkerIcon>
        <UIcon name="i-lucide-file-text" />
      </MarkerIcon>
      <MarkerContent>Opened implementation notes</MarkerContent>
    </Marker>
  </div>
</template>
