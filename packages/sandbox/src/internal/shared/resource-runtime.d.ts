export interface ProviderPort<TResolvedProvider, THandle, TContext> {
    resolve: (context: TContext) => Promise<TResolvedProvider> | TResolvedProvider;
    validate?: (provider: TResolvedProvider, context: TContext) => Promise<void> | void;
    create: (provider: TResolvedProvider, context: TContext) => Promise<THandle> | THandle;
}
export interface ResourceRuntimeContext<TConfig, TDefinition, TEvent = unknown> {
    feature: string;
    name: string;
    event: TEvent | undefined;
    config: TConfig | false | undefined;
    definition: TDefinition;
}
export interface ResourceRuntimeRegistry<TDefinition, TModule extends {
    default?: TDefinition;
} = {
    default?: TDefinition;
}> {
    entries: Record<string, TDefinition | (() => Promise<TModule>)>;
    validate?: (definition: TDefinition) => boolean;
}
export interface RuntimeCachePolicy<TResolvedProvider, THandle, TContext> {
    store: Map<string, Promise<THandle>>;
    isSafe: (provider: TResolvedProvider, context: TContext) => boolean;
    getKey?: (context: TContext) => string;
}
export interface ResourceRuntimeOptions<TConfig, TDefinition, TResolvedProvider, THandle, TEvent = unknown> {
    feature: string;
    readConfig: (runtimeConfig: Record<string, unknown>) => TConfig | false | undefined;
    getFallbackConfig: () => TConfig | false | undefined;
    registry: ResourceRuntimeRegistry<TDefinition>;
    port: ProviderPort<TResolvedProvider, THandle, ResourceRuntimeContext<TConfig, TDefinition, TEvent>>;
    cache?: RuntimeCachePolicy<TResolvedProvider, THandle, ResourceRuntimeContext<TConfig, TDefinition, TEvent>>;
}
export declare function readFeatureRuntimeConfig<TConfig>(readConfig: (runtimeConfig: Record<string, unknown>) => TConfig | false | undefined, getFallbackConfig: () => TConfig | false | undefined): false | TConfig;
export declare function loadResourceRuntimeContext<TConfig, TDefinition, TEvent = unknown>(options: Omit<ResourceRuntimeOptions<TConfig, TDefinition, never, never, TEvent>, 'port' | 'cache'>, name?: string): Promise<ResourceRuntimeContext<TConfig, TDefinition, TEvent>>;
export interface ResourceRuntime<TConfig, TDefinition, THandle, TEvent = unknown> {
    load: (name?: string) => Promise<ResourceRuntimeContext<TConfig, TDefinition, TEvent>>;
    get: (name?: string) => Promise<THandle>;
}
export declare function createResourceRuntime<TConfig, TDefinition, TResolvedProvider, THandle, TEvent = unknown>(options: ResourceRuntimeOptions<TConfig, TDefinition, TResolvedProvider, THandle, TEvent>): ResourceRuntime<TConfig, TDefinition, THandle, TEvent>;
