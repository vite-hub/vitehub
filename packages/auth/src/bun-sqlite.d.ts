// Better Auth's option types import `Database` from "bun:sqlite". This keeps that type without installing bun-types.
// An app that installs bun-types merges its `Database` class with this interface.
declare module "bun:sqlite" {
  export interface Database {
    readonly filename: string
    fileControl(op: number, arg?: ArrayBufferView | number): number
  }
}
