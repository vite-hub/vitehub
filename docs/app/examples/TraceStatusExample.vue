<template>
  <Trace class="w-full max-w-sm">
    <TraceLine>
      <TraceIcon><UIcon name="i-lucide-circle-check" /></TraceIcon>
      <TraceTitle>Ran pnpm install</TraceTitle>
    </TraceLine>
    <TraceLine status="error">
      <TraceIcon><UIcon name="i-lucide-circle-alert" /></TraceIcon>
      <TraceTitle>Failed to run pnpm lint</TraceTitle>
    </TraceLine>
    <TraceLine status="running">
      <TraceIcon><UIcon name="i-lucide-circle-dashed" /></TraceIcon>
      <TraceTitle>Running pnpm build</TraceTitle>
    </TraceLine>
    <TraceLine status="pending">
      <TraceIcon><UIcon name="i-lucide-circle" /></TraceIcon>
      <TraceTitle>Run pnpm test</TraceTitle>
    </TraceLine>
  </Trace>
</template>
