<template>
  <div class="flex w-full max-w-sm flex-col gap-6 py-4">
    <Message align="end">
      <MessageAvatar>
        <UAvatar text="ME" alt="You" />
      </MessageAvatar>
      <MessageContent>
        <Bubble>
          <BubbleContent>Deploying to prod real quick.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageAvatar>
        <UAvatar src="/vitehub-mark.png" alt="Reviewer" />
      </MessageAvatar>
      <MessageContent>
        <Bubble variant="muted">
          <BubbleContent>It's 4:55 PM. On a Friday.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message align="end">
      <MessageAvatar>
        <UAvatar text="ME" alt="You" />
      </MessageAvatar>
      <MessageContent>
        <Bubble>
          <BubbleContent>It's a one-line change.</BubbleContent>
        </Bubble>
        <MessageFooter>Delivered</MessageFooter>
      </MessageContent>
    </Message>
    <Message>
      <MessageAvatar>
        <UAvatar src="/vitehub-mark.png" alt="Reviewer" />
      </MessageAvatar>
      <MessageContent>
        <BubbleGroup>
          <Bubble variant="muted">
            <BubbleContent>It's always a one-line change 😭.</BubbleContent>
          </Bubble>
          <Bubble variant="muted">
            <BubbleContent>Alright, let me take a look at the diff.</BubbleContent>
            <BubbleReactions role="img" aria-label="Reaction: thumbs up">
              <span>👍</span>
            </BubbleReactions>
          </Bubble>
        </BubbleGroup>
      </MessageContent>
    </Message>
    <Marker role="status">
      <MarkerContent><span class="font-medium">Reviewer</span> is reading the diff...</MarkerContent>
    </Marker>
  </div>
</template>
