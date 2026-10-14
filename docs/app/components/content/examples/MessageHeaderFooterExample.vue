<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Message>
      <MessageContent>
        <MessageHeader>Reviewer</MessageHeader>
        <Bubble variant="muted">
          <BubbleContent>I already checked the logs.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Send the report to the team. Ask in #deploys if you need help.</BubbleContent>
        </Bubble>
        <MessageFooter>
          <div>Read <span class="font-normal">Yesterday</span></div>
        </MessageFooter>
      </MessageContent>
    </Message>
  </div>
</template>
