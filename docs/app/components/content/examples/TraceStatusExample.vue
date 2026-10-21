<template>
  <Trace class="w-full max-w-sm">
    <TraceLine>
      <TraceIcon><UIcon name="i-ph-check-circle-light" /></TraceIcon>
      <TraceTitle>Ran pnpm install</TraceTitle>
    </TraceLine>
    <TraceLine status="error">
      <TraceIcon><UIcon name="i-ph-warning-circle-light" /></TraceIcon>
      <TraceTitle>Failed to run pnpm lint</TraceTitle>
    </TraceLine>
    <TraceLine status="running">
      <TraceIcon><UIcon name="i-ph-circle-dashed-light" /></TraceIcon>
      <TraceTitle>Running pnpm build</TraceTitle>
    </TraceLine>
    <TraceLine status="pending">
      <TraceIcon><UIcon name="i-ph-circle-light" /></TraceIcon>
      <TraceTitle>Run pnpm test</TraceTitle>
    </TraceLine>
  </Trace>
</template>
