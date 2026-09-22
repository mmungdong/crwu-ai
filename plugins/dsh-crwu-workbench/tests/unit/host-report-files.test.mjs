/**
 * 「一份报告的全部相关文件」（`report-files`，第 26 个 Host 操作）的单元测试。
 *
 * 用户口径：「打开侧边栏的时候，crwu 应该同步去查询一份关于这个报告流水号的所有的内容，
 * 包括文件数据，但是不下载，只有当用户询问的时候才去下载」。所以这份测试盯三件事：
 * 1. **只列举、不下载** —— 只发 `ossutil ls`，绝不出现读对象内容的那条命令；
 * 2. 两个来源合并：云端对象（按流水号那层）+ 本地案例目录（只名字与大小）；
 * 3. 流水号进路径，所以形状不对一律拒绝、一条命令都不发；本地目录必须在选定工作空间之内。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { reportFiles } = await import(new URL('src/host/report/files.ts', ROOT).href)
const { normalizeManifest } = await import(new URL('src/host/environment/manifest.ts', ROOT).href)

const SEQ = '2026-302441-LX9967-BG8790'

/**
 * `crwu h3yun files list` 的**真实输出**（2026-09-22 在本机对真实记录抓的，只截了前四条）。
 * 形状是 `{data:[{field,fileId,fileName,fileSize,contentType,downloadUrl}]}` ——
 * 事件/接口的测试样本必须抄真实数据，别用想当然的形状（这一课在会话事件那处已经吃过一次）。
 */
const REAL_FILES_LIST = JSON.stringify({
  data: [
    {
      field: 'F0000143', fileId: 'c56efede-981e-48c5-a03d-83ab8bf87d98',
      fileName: 'V2定稿-估值报告-华润万家住宅.zip', fileSize: '78761669',
      contentType: 'application/zip', downloadUrl: '/Form/Download/?AttachmentID=c56efede-981e-48c5-a03d-83ab8bf87d98',
    },
    {
      field: 'F0000077', fileId: '3bfb398c-2385-41a4-ade9-ab407723c1c3',
      fileName: '宝应安宜209室不动产证.PDF', fileSize: '2039361',
      contentType: 'application/pdf', downloadUrl: '/Form/Download/?AttachmentID=3bfb398c-2385-41a4-ade9-ab407723c1c3',
    },
  ],
})

function manifest() {
  return normalizeManifest({
    oss: { enabled: true, bucket: 'bkt', prefix: 'crwu/audit', linkMode: 'signed', linkTtl: 3600, autoUpload: true },
  })
}

/** 一份假的 Host 依赖：shell 记命令，fs 只认预先摆好的目录树。 */
function deps(patch = {}) {
  const commands = []
  const ctx = {
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => { commands.push(request.command); return request },
          async run(spec) {
            const out = patch.shell === undefined ? { stdout: '' } : patch.shell(spec.command)
            return {
              exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
              stdout: { text: out.stdout ?? '', truncated: out.truncated === true },
              stderr: { text: out.stderr ?? '', truncated: false },
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async listDir(target) {
            const rows = (patch.dirs ?? {})[target.targetKey]
            if (rows === undefined) throw new Error('ENOENT')
            return rows
          },
        }
      }
      return undefined
    },
  }
  return {
    commands,
    value: {
      ctx,
      oss: {
        ctx,
        manifest: manifest(),
        platform: 'darwin',
        workdir: async () => '/tmp',
        home: '/tmp/home',
      },
      workspacePath: () => patch.workspacePath ?? '/ws/中瑞世联工作空间',
      // 氚云那一路：表单 code + 授权状态（没授权就不该去读钥匙串）。
      formCode: () => patch.formCode ?? 'Srabfcm8figc1xuzxawc5u04x5',
      trusted: patch.trusted !== false,
      platform: 'darwin',
      workdir: async () => '/tmp',
    },
  }
}

test('report-files：云端按流水号列举 + 本地案例目录，一次调用两个来源都回（不下载）', async () => {
  const harness = deps({
    shell: (command) => ({
      // 假 shell 必须**按命令**回答：`command -v ossutil` 那条是二进制探测，要回路径；
      // 其余（`ls`）才回对象清单（踩过：对每条命令都回同一段 stdout，探测那条把对象 URL
      // 当成了 ossutil 的路径，于是列举命令整个变形）。
      stdout: command.startsWith('command -v')
        ? '/usr/local/bin/ossutil\n'
        : (command.includes('files list')
            ? REAL_FILES_LIST
            : [
                'oss://bkt/crwu/audit/2026-302441-LX9967-BG8790/审核意见.2026-302441-LX9967-BG8790.html',
                'oss://bkt/crwu/audit/2026-302441-LX9967-BG8790/审核结果.2026-302441-LX9967-BG8790.json',
              ].join('\n')),
    }),
    dirs: {
      '/ws/中瑞世联工作空间/2026-302441-LX9967-BG8790': [
        { name: '材料', type: 'directory', target: { targetKey: '/ws/中瑞世联工作空间/2026-302441-LX9967-BG8790/材料' } },
        { name: '说明.md', type: 'file', size: 2048, target: { targetKey: '/ws/中瑞世联工作空间/2026-302441-LX9967-BG8790/说明.md' } },
      ],
      '/ws/中瑞世联工作空间/2026-302441-LX9967-BG8790/材料': [
        { name: '评估明细表.xlsx', type: 'file', size: 3145728, target: { targetKey: '/ws/中瑞世联工作空间/2026-302441-LX9967-BG8790/材料/评估明细表.xlsx' } },
      ],
    },
  })

  const result = await reportFiles(harness.value, { seqNo: SEQ, objectId: '5f6924e2-f722-4477-9d34-d52aa855a1ad' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.seqNo, SEQ)
  // 氚云附件（权威来源）：名字与大小都来自 `files list` 的元数据，**没有下载**。
  assert.deepEqual(result.h3yun.map((file) => file.name), ['V2定稿-估值报告-华润万家住宅.zip', '宝应安宜209室不动产证.PDF'])
  assert.equal(result.h3yun[0].size, 78761669)
  assert.equal(result.h3yun[1].contentType, 'application/pdf')
  assert.equal(result.h3yunError, '')
  // 云端：两个成对交付件都列出来了。
  assert.deepEqual(result.oss.map((file) => file.name).sort(), [
    `审核意见.${SEQ}.html`, `审核结果.${SEQ}.json`,
  ].sort())
  // 本地：递归到子目录，带相对路径与大小。
  assert.deepEqual(result.local.map((file) => file.path).sort(), [
    `/ws/中瑞世联工作空间/${SEQ}/说明.md`,
    `/ws/中瑞世联工作空间/${SEQ}/材料/评估明细表.xlsx`,
  ].sort())
  assert.equal(result.localExists, true)
  assert.equal(result.localDir, `/ws/中瑞世联工作空间/${SEQ}`)
  // **只列举、不下载**：跑的是 `ossutil ls` 与 `crwu h3yun files list`（外加探测二进制那条），
  // 任何一条命令都不该出现下载附件的路子（`file get` / `file download` / `cp` / `cat`）。
  assert.ok(
    harness.commands.some((command) => /ossutil ls /.test(command)),
    `要有一条按流水号的列举：${harness.commands.join(' || ')}`,
  )
  assert.ok(
    harness.commands.some((command) => /h3yun files list/.test(command)),
    `要用 crwu 自己的方式列附件：${harness.commands.join(' || ')}`,
  )
  for (const command of harness.commands) {
    assert.equal(/file (get|download)/.test(command), false, `这条命令会下载附件：${command}`)
    assert.equal(/\bcp\b|\bcat\b/.test(command), false, `这条命令像是在下载内容：${command}`)
  }
})

test('report-files：流水号形状不对就地拒绝，一条命令都不发（安全边界）', async () => {
  const harness = deps()
  for (const bad of ['', '../../etc', 'a/b', 'x y']) {
    const result = await reportFiles(harness.value, { seqNo: bad })
    assert.equal(result.ok, false, `应当拒绝：${bad}`)
    assert.deepEqual(result.oss, [])
  }
  assert.deepEqual(harness.commands, [], '形状不对时不该发出任何命令')
})

test('report-files：本地没有这个案例目录 ≠ 空目录（界面要分开说）', async () => {
  const harness = deps({ shell: () => ({ stdout: '' }), dirs: {} })
  const result = await reportFiles(harness.value, { seqNo: SEQ })
  assert.equal(result.ok, true)
  assert.equal(result.localExists, false)
  assert.deepEqual(result.local, [])
  assert.equal(result.localDir, `/ws/中瑞世联工作空间/${SEQ}`, '路径照样给出来，界面才知道去哪找')
})

test('report-files：没选工作空间时本地部分为空，但云端照常查', async () => {
  // 云端那半照常按流水号列举（对象放在该流水号自己的目录下）。
  const harness = deps({
    workspacePath: '',
    shell: (command) => ({
      stdout: command.startsWith('command -v') ? '/usr/local/bin/ossutil\n' : `oss://bkt/crwu/audit/${SEQ}/审核意见.${SEQ}.html`,
    }),
  })
  const result = await reportFiles(harness.value, { seqNo: SEQ })
  assert.equal(result.ok, true)
  assert.equal(result.localDir, '')
  assert.deepEqual(result.local, [])
  assert.equal(result.oss.length, 1, '工作空间没选不该把云端那半也丢掉')
})

test('report-files：没授权就不去读氚云（不假装"没有附件"）', async () => {
  const harness = deps({ trusted: false, dirs: {} })
  const result = await reportFiles(harness.value, { seqNo: SEQ, objectId: '5f6924e2-f722-4477-9d34-d52aa855a1ad' })
  assert.deepEqual(result.h3yun, [])
  assert.match(result.h3yunError, /授权/, '要说清是"还没授权"，而不是"没有附件"')
  assert.equal(
    harness.commands.some((command) => /files list/.test(command)), false,
    '没授权时不该去读钥匙串（那条命令问出来的"没登录"是假的）',
  )
})

test('parseH3yunFiles：真样本照单全收，形状不对的条目跳过（不让一条脏数据毁掉整份清单）', async () => {
  const { parseH3yunFiles } = await import(new URL('src/host/report/files.ts', ROOT).href)
  const parsed = parseH3yunFiles(JSON.parse(REAL_FILES_LIST))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].fileId, 'c56efede-981e-48c5-a03d-83ab8bf87d98')
  assert.equal(parsed[0].field, 'F0000143')
  assert.deepEqual(parseH3yunFiles({ data: [null, 42, { fileId: 'x' }, { fileName: 'ok.pdf' }] }), [
    { field: '', fileId: '', name: 'ok.pdf', size: 0, contentType: '' },
  ])
  assert.deepEqual(parseH3yunFiles(null), [])
  assert.deepEqual(parseH3yunFiles({ data: 'nope' }), [])
})
