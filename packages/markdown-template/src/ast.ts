type ComarkElementAttributes = Record<string, unknown>
type ComarkComment = [null, ComarkElementAttributes, string]

export type ComarkElement = [string, ComarkElementAttributes, ...ComarkNode[]]
export type ComarkNode = ComarkComment | ComarkElement | string
