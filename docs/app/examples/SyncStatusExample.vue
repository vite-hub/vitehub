<template>
  <div class="flex flex-col items-start gap-3">
    <SyncStatus status="loading" />
    <SyncStatus status="synchronizing" />
    <SyncStatus status="synchronized" />
    <SyncStatus status="error" />
  </div>
</template>
