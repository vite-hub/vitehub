<script setup lang="ts">
import { Bubble, BubbleContent } from "../bubble/index.ts";
import { Message, MessageContent, MessageFooter, MessageGroup, MessageHeader } from "../message/index.ts";
</script>

<template>
  <div data-slot="example-message" style="display: flex; flex-direction: column; gap: 1rem; max-width: 28rem">
    <Message align="end">
      <MessageContent>
        <Bubble variant="soft">
          <BubbleContent>Why did the last deploy fail?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <MessageGroup>
      <Message>
        <MessageContent>
          <MessageHeader>Agent</MessageHeader>
          <Bubble variant="ghost">
            <BubbleContent>The build ran out of memory while it bundled the docs.</BubbleContent>
          </Bubble>
          <MessageFooter>2 minutes ago</MessageFooter>
        </MessageContent>
      </Message>
    </MessageGroup>
  </div>
</template>
