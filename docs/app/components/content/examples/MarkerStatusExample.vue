<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Marker role="status">
      <MarkerIcon>
        <UIcon name="i-ph-circle-dashed-light" />
      </MarkerIcon>
      <MarkerContent>Compacting the conversation</MarkerContent>
    </Marker>
    <Marker variant="separator" role="status">
      <MarkerIcon>
        <UIcon name="i-ph-circle-dashed-light" />
      </MarkerIcon>
      <MarkerContent>Running pnpm test</MarkerContent>
    </Marker>
  </div>
</template>
