import { isLocalPathUnder } from '../../../shared/utils/local-path.ts'

/**
 * 估值工作流存储连接的**关闭收尾**。
 *
 * `host.ts` 用一个 `Map<workspaceId\0storePath, Promise<Session>>` 缓存已打开的
 * `workflows.sqlite`。清空工作空间时要删掉 `<W>/.crwu`，Windows 上文件被占用会直接失败，
 * 所以先按 **store 路径** 把落在 W 之下的连接关掉。
 *
 * 判据不能只看 `workspaceId`：同一个工作区可能有历史 store 路径（旧目录布局），
 * 那些连接同样占着文件。关闭失败不阻断清理 —— 继续删其余项，让 `.crwu` 自己记失败。
 */
export interface ClosableStore {
  close(): Promise<void>
}

export async function closeStoresUnder(
  sessions: Map<string, Promise<ClosableStore>>,
  opened: Set<ClosableStore>,
  workspacePath: string,
): Promise<string[]> {
  const closed: string[] = []
  for (const [key, pending] of [...sessions.entries()]) {
    const separator = key.indexOf('\u0000')
    const storePath = separator < 0 ? '' : key.slice(separator + 1)
    if (storePath === '' || !isLocalPathUnder(storePath, workspacePath)) continue
    let store: ClosableStore
    try {
      store = await pending
    } catch {
      // The open promise rejected: there is no handle to close, drop the dead entry.
      sessions.delete(key)
      continue
    }
    try {
      await store.close()
      sessions.delete(key)
      opened.delete(store)
      closed.push(key)
    } catch {
      // A close failure (typically a Windows file lock) keeps the handle tracked so a
      // later cleanup can try again; losing it here would lock `.crwu` until restart.
    }
  }
  return closed
}
