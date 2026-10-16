<template>
  <MessageGroup class="w-full max-w-lg">
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Why did the deploy fail?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageAvatar class="size-8 text-xs font-medium">
        AI
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>Reviewer</MessageHeader>
        <Bubble variant="secondary">
          <BubbleContent>
            The build ran with a frozen lockfile, but <code>pnpm-lock.yaml</code> was out of date.
          </BubbleContent>
        </Bubble>
        <MessageFooter>2 min ago</MessageFooter>
      </MessageContent>
    </Message>
  </MessageGroup>
</template>
