export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function cloneFeatureOptions<T extends object>(feature: string, options: T): T;
export declare function normalizeFeatureOptions<T extends object>(feature: string, options: T | false | undefined): T | undefined;
