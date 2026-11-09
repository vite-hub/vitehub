<script setup lang="ts">
const reasoning = "The build log shows install and compile finish in under a minute. Image optimization takes almost four, and it runs again on every deploy because the cache key includes the commit hash.";
const answer = "Image optimization is the bottleneck. Key its cache on the lockfile and the image directory instead of the commit hash.";

const started = ref(false);
const running = ref(false);
const text = ref("");
const reply = ref("");
// `undefined` until the reader toggles the line, so the line follows `running` until then.
const open = ref<boolean>();
let timer: ReturnType<typeof setInterval> | undefined;

function send() {
  started.value = true;
  running.value = true;
  const words = reasoning.split(" ");
  let index = 0;
  timer = setInterval(() => {
    index += 1;
    text.value = words.slice(0, index).join(" ");
    if (index < words.length) return;
    clearInterval(timer);
    running.value = false;
    reply.value = answer;
  }, 80);
}

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="flex min-h-72 w-full max-w-sm flex-col gap-4 text-sm">
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="muted">
          <BubbleContent>Why is the checkout deploy so slow?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message v-if="started">
      <MessageContent class="gap-4">
        <Trace>
          <TraceLine v-if="!text" status="running">
            <TraceIcon><UIcon name="i-ph-brain-light" /></TraceIcon>
            <TraceTitle>Thinking</TraceTitle>
          </TraceLine>
          <TraceCollapsible v-else :open="open ?? running" @update:open="open = $event">
            <TraceCollapsibleTrigger>
              <TraceLine :status="running ? 'running' : undefined">
                <TraceIcon><UIcon name="i-ph-brain-light" /></TraceIcon>
                <TraceTitle>{{ running ? "Thinking" : "Thought" }}</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent class="whitespace-pre-wrap">
              {{ text }}
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
        <p v-if="reply">
          {{ reply }}
        </p>
      </MessageContent>
    </Message>
    <UButton v-if="!started" color="neutral" variant="outline" size="sm" class="mt-auto self-start" @click="send">
      Send message
    </UButton>
  </div>
</template>
