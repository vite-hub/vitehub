<template>
  <div class="w-full max-w-sm">
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine status="error">
          <TraceTitle>Worked for 2m 4s, 1 command failed</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent class="flex flex-col gap-2">
        <Trace>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon><UIcon name="i-ph-brain-light" /></TraceIcon>
                <TraceTitle>Thought</TraceTitle>
                <TraceDescription>12 s</TraceDescription>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent class="whitespace-pre-wrap">
              I should check which package managers are installed before I scaffold anything.
            </TraceCollapsibleContent>
          </TraceCollapsible>
          <TraceCollapsible default-open>
            <TraceCollapsibleTrigger>
              <TraceLine status="error">
                <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
                <TraceTitle>Ran 2 commands, 1 failed</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <Trace>
                <TraceLine>
                  <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
                  <TraceTitle>Ran node --version</TraceTitle>
                </TraceLine>
                <TraceCollapsible>
                  <TraceCollapsibleTrigger>
                    <TraceLine status="error">
                      <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
                      <TraceTitle>Failed to run pnpm --version</TraceTitle>
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent>
                    <CodeBlock size="sm" variant="destructive">
                      <CodeBlockContent wrap class="max-h-64">command not found: pnpm</CodeBlockContent>
                    </CodeBlock>
                  </TraceCollapsibleContent>
                </TraceCollapsible>
              </Trace>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
        <p class="text-sm text-default">
          Node is installed and pnpm is not. Reading the Nuxt config.
        </p>
        <Trace>
          <a href="#whole-turn">
            <TraceLine>
              <TraceIcon><UIcon name="i-ph-file-text-light" /></TraceIcon>
              <TraceTitle>Read nuxt.config.ts</TraceTitle>
              <TraceIcon><UIcon name="i-ph-caret-right-light" /></TraceIcon>
            </TraceLine>
          </a>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </div>
</template>
