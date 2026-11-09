<template>
  <div class="flex w-full max-w-sm flex-col gap-6">
    <MessageGroup>
      <Message>
        <MessageAvatar />
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent>I checked the registry addresses.</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message>
        <MessageAvatar>
          <UAvatar src="/vitehub-mark.png" alt="Agent" />
        </MessageAvatar>
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent>The component and example JSON now live in the UI registry.</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </MessageGroup>
  </div>
</template>
