<template>
  <div class="flex w-full max-w-sm flex-col gap-8">
    <Message align="end">
      <MessageContent>
        <Attachment orientation="vertical" class="w-40">
          <AttachmentMedia variant="image">
            <img src="/examples/my-pull-requests.jpg" alt="A list of open pull requests">
          </AttachmentMedia>
        </Attachment>
        <Bubble>
          <BubbleContent>Here is the screenshot. Can you add it to the release notes as the cover image?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageContent>
        <Bubble variant="muted">
          <BubbleContent>Done. Here are the release notes with the screenshot as the cover image.</BubbleContent>
        </Bubble>
        <Attachment>
          <AttachmentMedia>
            <UIcon name="i-ph-file-text-light" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>release-notes.pdf</AttachmentTitle>
            <AttachmentDescription>PDF · 2.4 MB</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction icon="i-ph-download-simple-light" aria-label="Download release-notes.pdf" />
          </AttachmentActions>
        </Attachment>
      </MessageContent>
    </Message>
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Thanks. Looks good.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  </div>
</template>
