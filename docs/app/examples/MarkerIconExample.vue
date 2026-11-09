<template>
  <div class="flex w-full max-w-sm flex-col gap-12">
    <Marker>
      <MarkerIcon>
        <UIcon name="i-lucide-git-branch" />
      </MarkerIcon>
      <MarkerContent>Switched to a new branch</MarkerContent>
    </Marker>
    <Marker variant="separator">
      <MarkerIcon>
        <UIcon name="i-lucide-search" />
      </MarkerIcon>
      <MarkerContent>Explored 4 files</MarkerContent>
    </Marker>
    <Marker class="flex-col">
      <MarkerIcon>
        <UIcon name="i-lucide-book-open" />
      </MarkerIcon>
      <MarkerContent>Sync completed</MarkerContent>
    </Marker>
  </div>
</template>
