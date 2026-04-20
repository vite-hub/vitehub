import { c as QueueDefinition } from "../types-DHLfmgAh.js";

//#region src/runtime/hosted.d.ts
declare function handleHostedVercelQueueCallback(event: {
  method?: string;
  request?: Request;
}, name: string, definition: QueueDefinition): Promise<unknown>;
//#endregion
export { handleHostedVercelQueueCallback };