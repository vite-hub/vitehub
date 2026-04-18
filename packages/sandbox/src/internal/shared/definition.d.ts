export type DefinitionHandler = (...args: never[]) => unknown;
export declare function assertDefinitionHandler(functionName: string, handler: unknown, label: string): asserts handler is DefinitionHandler;
export declare function validateDefinitionOptions<T>(functionName: string, options: unknown, config: {
    allowedKeys?: readonly string[];
    disallowedKeys?: readonly string[];
    invalidKeysMessage: string;
}): T | undefined;
