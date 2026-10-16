<template>
  <ConnectionStatus status="connected">
    <ConnectionStatusIndicator />
    <ConnectionStatusLabel v-slot="{ state }">
      {{ state === "connected" ? "Live" : "Offline, edits are kept" }}
    </ConnectionStatusLabel>
  </ConnectionStatus>
</template>
