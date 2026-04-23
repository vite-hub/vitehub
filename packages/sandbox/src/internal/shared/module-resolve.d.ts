export interface ResolvedModuleResult {
    ok: true;
    path: string;
}
export interface MissingModuleResult {
    ok: false;
    error: string;
}
export declare function tryResolveModule(id: string, options?: {
    paths?: string[];
}): ResolvedModuleResult | MissingModuleResult;
export declare function canResolveModule(moduleName: string, options?: {
    paths?: string[];
}): boolean;
export declare function clearResolveCache(): void;
