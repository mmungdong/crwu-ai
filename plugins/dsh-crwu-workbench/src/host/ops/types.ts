export type OperationArgs = Record<string, unknown>
export interface OperationContext { signal?: AbortSignal }
export type Operation = (args: OperationArgs, context?: OperationContext) => Promise<unknown> | unknown
export type OperationMap = Record<string, Operation>
