import { onBeforeUnmount, onMounted, ref } from "vue";
import { timeAgo } from "./format.ts";

/** The text of a past time, and its full local date and time for a tooltip once the browser knows them. */
export interface RelativeTime {
  text: string;
  title?: string;
}

export type RelativeTimeFormat = (at: number) => RelativeTime;

const serverDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

/**
 * Formats past times such as "5 minutes ago" from `setup()`. Until the component mounts, it gives the UTC date, so the
 * server and the first client render match. After that it counts from the browser clock each minute.
 */
export function useRelativeTime(): RelativeTimeFormat {
  const now = ref<number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    now.value = Date.now();
    timer = setInterval(() => (now.value = Date.now()), 60_000);
  });
  onBeforeUnmount(() => clearInterval(timer));
  return (at) => now.value === undefined
    ? { text: serverDate.format(at) }
    : { text: timeAgo(at, now.value), title: new Date(at).toLocaleString() };
}
