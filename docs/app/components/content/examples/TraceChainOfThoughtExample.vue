<template>
  <div class="w-full max-w-sm">
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine status="running">
          <TraceTitle>Looking into the slow deploy</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon><UIcon name="i-ph-magnifying-glass-light" /></TraceIcon>
                <TraceTitle>Searched for the checkout build log</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent class="flex flex-wrap gap-1.5">
              <UBadge color="neutral" variant="soft">
                dash.cloudflare.com
              </UBadge>
              <UBadge color="neutral" variant="soft">
                github.com
              </UBadge>
            </TraceCollapsibleContent>
          </TraceCollapsible>
          <a href="#chain-of-thought">
            <TraceLine>
              <TraceIcon><UIcon name="i-ph-file-text-light" /></TraceIcon>
              <TraceTitle>Read the last twelve deploys</TraceTitle>
              <TraceIcon><UIcon name="i-ph-caret-right-light" /></TraceIcon>
            </TraceLine>
          </a>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine status="running">
                <TraceIcon><UIcon name="i-ph-magnifying-glass-light" /></TraceIcon>
                <TraceTitle>Searching for the cache key</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <CodeBlock size="sm">
                <CodeBlockContent wrap class="max-h-64">cache key image optimization</CodeBlockContent>
              </CodeBlock>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </div>
</template>
