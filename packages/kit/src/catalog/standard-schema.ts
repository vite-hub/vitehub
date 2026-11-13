// The Standard Schema and Standard JSON Schema interfaces, copied as the spec asks (https://standardschema.dev), so the
// declarations of this package need no extra install.

/** A schema of any library that implements Standard Schema V1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown, options?: Options) => Result<Output> | Promise<Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  }
  export interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
}

/** A schema of any library that implements Standard JSON Schema V1. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardJSONSchemaV1.Props<Input, Output>;
}

export declare namespace StandardJSONSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly jsonSchema: Converter;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  }
  export interface Converter {
    readonly input: (options: Options) => Record<string, unknown>;
    readonly output: (options: Options) => Record<string, unknown>;
  }
  export interface Options {
    readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
}
