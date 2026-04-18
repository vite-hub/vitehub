export interface StorageEnv {
    [key: string]: string | undefined;
}
export type StorageConfigSource = 'explicit' | 'env' | 'hosting' | 'fallback';
export interface StorageConfigContext {
    env: StorageEnv;
    hosting: string;
}
export interface StorageConfigResult<TConfig> {
    config: TConfig;
    source: StorageConfigSource;
}
export interface StorageConfigInput {
    env?: StorageEnv;
    hosting?: string | null;
}
export interface StorageConfigResolver<TOptions extends object, TConfig> {
    source: StorageConfigSource;
    resolve: (options: TOptions, context: StorageConfigContext) => TConfig | undefined;
}
export declare function normalizeStorageConfigInput(input?: string | StorageConfigInput): StorageConfigContext;
export declare function normalizeStorageOptions<TOptions extends object>(options: TOptions | false | undefined): TOptions | undefined;
export declare function readStorageEnv(env: StorageEnv, ...keys: string[]): string | undefined;
export declare function resolveStorageConfig<TOptions extends object, TConfig>(options: TOptions | false | undefined, input: string | StorageConfigInput | undefined, candidates: StorageConfigResolver<TOptions, TConfig>[]): StorageConfigResult<TConfig> | undefined;
