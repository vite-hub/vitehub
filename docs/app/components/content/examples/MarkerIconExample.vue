<template>
  <div class="flex w-full max-w-sm flex-col gap-12">
    <Marker>
      <MarkerIcon>
        <UIcon name="i-ph-git-branch-light" />
      </MarkerIcon>
      <MarkerContent>Switched to a new branch</MarkerContent>
    </Marker>
    <Marker variant="separator">
      <MarkerIcon>
        <UIcon name="i-ph-magnifying-glass-light" />
      </MarkerIcon>
      <MarkerContent>Explored 4 files</MarkerContent>
    </Marker>
    <Marker class="flex-col">
      <MarkerIcon>
        <UIcon name="i-ph-book-open-light" />
      </MarkerIcon>
      <MarkerContent>Sync completed</MarkerContent>
    </Marker>
  </div>
</template>
