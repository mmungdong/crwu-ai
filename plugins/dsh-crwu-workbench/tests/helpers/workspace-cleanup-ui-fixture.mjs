/** In-memory view facts only; no workspace, session store, or cleanup operation is accessed. */
export function cleanupUiState(kind = 'ready') {
  const state = {
    phase: 'ready', error: '', result: null, confirmName: '', deleteSessionLogs: false, startedAt: 0,
    plan: {
      ok: true, error: '', errorKind: '', planId: 'fixture', digest: 'fixture', expiresAt: 0,
      workspace: { path: '/fixture/中瑞世联工作空间', name: '中瑞世联工作空间', id: 'fixture' },
      entries: [{ name: '.crwu', kind: 'directory', sizeBytes: 40960 }], entriesTruncated: 0,
      sessions: [],
      totals: {
        folders: 1, files: 0, symlinks: 0, other: 0, bytes: 40960, bytesComplete: true,
        sessions: 0, topLevelSessions: 0, subagentSessions: 0, runningSessions: 0,
      },
      notes: ['已归档、不在会话列表里的旧会话无法枚举，其日志可能残留。',
        '物理删除会话日志后，侧栏可能需要重启 DSH 才更新。'],
    },
  }
  if (kind === 'long') {
    state.plan.workspace.path = `D:\\工作资料\\${'很长的工作空间路径'.repeat(12)}\\中瑞世联工作空间`
    state.plan.entries = Array.from({ length: 35 }, (_, i) => ({
      name: `${String(i + 1)}-${'很长的报告文件夹名称'.repeat(5)}`, kind: 'directory', sizeBytes: 1024,
    }))
    state.plan.totals.folders = 35
    state.plan.totals.bytes = 35 * 1024
    state.plan.totals.bytesComplete = false
    state.plan.totals.runningSessions = 1
    state.plan.totals.sessions = 3
    state.plan.totals.topLevelSessions = 1
    state.plan.totals.subagentSessions = 2
  }
  return state
}
