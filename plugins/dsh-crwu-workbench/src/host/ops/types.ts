export type OperationArgs = Record<string, unknown>
export type Operation = (args: OperationArgs) => Promise<unknown> | unknown
export type OperationMap = Record<string, Operation>
