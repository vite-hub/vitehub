import { b as ResolvedQueueModuleOptions, c as QueueDefinition, u as QueueDefinitionRegistry } from "../types-DHLfmgAh.js";

//#region src/runtime/state.d.ts
declare function setQueueRuntimeConfig(config: false | ResolvedQueueModuleOptions | undefined): void;
declare function getQueueRuntimeConfig(): false | ResolvedQueueModuleOptions | undefined;
declare function runWithQueueRuntimeEvent<T>(event: unknown, callback: () => T): T;
declare function enterQueueRuntimeEvent(event: unknown): void;
declare function getQueueRuntimeEvent(): unknown;
declare function setQueueRuntimeRegistry(registry: QueueDefinitionRegistry | undefined): void;
declare function getQueueClientCache(): Map<string, Promise<unknown>>;
declare function loadQueueDefinition(name: string): Promise<QueueDefinition | undefined>;
//#endregion
export { enterQueueRuntimeEvent, getQueueClientCache, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry };