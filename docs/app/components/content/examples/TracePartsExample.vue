<template>
  <Trace class="max-w-lg">
    <TraceLine>
      <TraceIcon><UIcon name="i-ph-magnifying-glass-light" /></TraceIcon>
      <TraceTitle>Searched for minimumReleaseAge</TraceTitle>
      <TraceDescription>3 results</TraceDescription>
    </TraceLine>
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
          <TraceTitle>Ran node --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent class="font-mono text-xs">
        v24.18.0
      </TraceCollapsibleContent>
    </TraceCollapsible>
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
