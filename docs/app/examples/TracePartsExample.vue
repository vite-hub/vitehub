<template>
  <Trace class="max-w-lg">
    <TraceLine>
      <TraceIcon><UIcon name="i-lucide-search" /></TraceIcon>
      <TraceTitle>Searched for minimumReleaseAge</TraceTitle>
      <TraceDescription>3 results</TraceDescription>
    </TraceLine>
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-lucide-terminal" /></TraceIcon>
          <TraceTitle>Ran node --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent class="font-mono text-xs">
        v24.18.0
      </TraceCollapsibleContent>
    </TraceCollapsible>
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
