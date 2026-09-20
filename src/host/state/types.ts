/** 单条审核运行记录。 */
export interface AuditRecord {
  key: string
  childId: string
  seqNo: string
  project: string
  objectId: string
  startedAt: string
  parentSessionId: string
  status: string
  ended: boolean
  stopped: boolean
  stopReason: string
  endReason: string
  casePath: string
  resultFile: string
  htmlFile: string
  caseName: string
  uploadedAt: string
  uploadError: string
  ossPrefix: string
  attempt: number
  childAlive?: boolean
  adopted?: boolean
}

/** Host 插件实例的进程内状态。 */
export interface WorkbenchState {
  caseRoot: string
  workspacePath: string
  workspaceTitle: string
  workspaceSource: string
  workspaceChosen: boolean
  parentSessionId: string
  trustH3yun: boolean
  audits: Record<string, AuditRecord>
  activeKey: string
  activeChildId: string
  activeSince: number
}
