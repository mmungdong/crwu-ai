/**
 * 工作空间清理测试用的**内存文件系统**。
 *
 * 只实现 `CleanupIo` 的六个动词，并让 `removeTree` / `unlink` 真的改内存树 ——
 * 执行编排里的 `remaining` 回读才有意义（否则测试会自己骗自己）。
 * 路径按 `/` 或 `\` 两种分隔符取父目录，够 Windows 用例用。
 */
export function memoryCleanupIo(initial, options = {}) {
  const nodes = initial.map((node) => ({ ...node }))
  const calls = []
  const realpaths = options.realpaths ?? {}

  function parentOf(path) {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (cut < 0) return ''
    if (cut === 0) return path.slice(0, 1)
    if (cut === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3)
    return path.slice(0, cut)
  }

  function statsOf(node) {
    if (node === undefined) return undefined
    return {
      isDirectory: () => node.kind === 'dir',
      isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'symlink',
      size: node.size ?? 0,
      mtimeMs: node.mtimeMs ?? 1,
    }
  }

  return {
    nodes,
    calls,
    parentOf,
    async readdir(path) {
      calls.push(`readdir ${path}`)
      return nodes
        .filter((node) => parentOf(node.path) === path)
        .map((node) => ({
          name: node.path.slice(path.length).replace(/^[\\/]+/, ''),
          isDirectory: () => node.kind === 'dir',
          isFile: () => node.kind === 'file',
          isSymbolicLink: () => node.kind === 'symlink',
        }))
    },
    async lstat(path) {
      calls.push(`lstat ${path}`)
      return statsOf(nodes.find((node) => node.path === path))
    },
    async stat(path) {
      calls.push(`stat ${path}`)
      return statsOf(nodes.find((node) => node.path === path))
    },
    async realpath(path) {
      calls.push(`realpath ${path}`)
      return realpaths[path] ?? path
    },
    async removeTree(path) {
      calls.push(`removeTree ${path}`)
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]
        if (node.path === path || node.path.startsWith(`${path}/`) || node.path.startsWith(`${path}\\`)) {
          nodes.splice(index, 1)
        }
      }
    },
    async unlink(path) {
      calls.push(`unlink ${path}`)
      const index = nodes.findIndex((node) => node.path === path)
      if (index >= 0) nodes.splice(index, 1)
    },
  }
}
