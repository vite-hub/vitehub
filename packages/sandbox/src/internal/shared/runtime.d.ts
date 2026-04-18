import type { useRuntimeConfig } from 'nitro/runtime-config';
export declare function safeUseRequest<TEvent = unknown>(): TEvent;
export declare function readRuntimeValue<T>(read: (config: ReturnType<typeof useRuntimeConfig>) => T | undefined, fallback: () => T | undefined): T | undefined;
export declare function loadRegistryEntry<TEntry, TModule extends {
    default?: TEntry;
}>(registry: Record<string, TEntry | (() => Promise<TModule>)>, name: string): Promise<TEntry | undefined>;
