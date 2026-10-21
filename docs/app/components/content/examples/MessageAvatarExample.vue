<template>
  <div class="flex w-full max-w-sm flex-col gap-6">
    <Message>
      <MessageAvatar>
        <UAvatar src="/vitehub-mark.png" alt="Agent" />
      </MessageAvatar>
      <MessageContent>
        <Bubble variant="muted">
          <BubbleContent>The build failed during dependency installation.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message align="end">
      <MessageAvatar>
        <UAvatar src="/github-org-avatar.png" alt="You" />
      </MessageAvatar>
      <MessageContent>
        <Bubble>
          <BubbleContent>Can you share the exact error?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageAvatar>
        <UAvatar src="/vitehub-mark.png" alt="Agent" />
      </MessageAvatar>
      <MessageContent>
        <BubbleGroup>
          <Bubble variant="muted">
            <BubbleContent>Here is the error from the logs.</BubbleContent>
          </Bubble>
          <Bubble variant="muted">
            <BubbleContent>
              ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json.
            </BubbleContent>
          </Bubble>
        </BubbleGroup>
      </MessageContent>
    </Message>
  </div>
</template>
