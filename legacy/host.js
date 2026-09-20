return {
  apply(ctx) {
    const DEFAULT_CASE_ROOT = '/Users/mungdong/crwu-audit-workspace'
    const DEFAULT_MANIFEST_SOURCE = 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-manifest.json'
    const DEFAULT_INSTALL_DOC = 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-install.md'
    const DEFAULT_FORM_NAME = '报告审核'
    const RECORDS_STDOUT_MAX = 4 * 1024 * 1024
    const SEQ_NO_FULL = /^\d{4}-\d+-[A-Za-z]+\d+(?:-[A-Za-z]+\d+)?$/
    const OSSUTIL_VERSION = '1.7.19'
    const OSSUTIL_BASE = 'https://gosspublic.alicdn.com/ossutil/' + OSSUTIL_VERSION
    const CRWU_BASE = 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-bin'
    const state = {
      root: '', sessionRoot: '', home: '', manifest: null, manifestSource: '',
      formCode: '', formName: '', trustH3yun: false,
      parentSessionId: '', audits: {},
      workspacePath: '', workspaceChosen: false, platform: '',
      workspaceSource: '', workspaceTitle: '', workspaceId: '',
      activeKey: '', activeChildId: '', activeSince: 0, startingKey: '',
      uploadTimer: null,
      // childId → { run, abort }。这是活的进程内句柄，绝不能进任何 JSON 返回值：
      // audit-status 会用 Object.assign 复制审计记录，所以单独放一张表。
      // 活句柄不可持久化 —— 插件一重装（每次 cordis_define/cordis_run 都是新 Package，
      // 旧 apply 被 dispose）这张表就空了，而子会话仍在跑。所以审计**记录**另行落盘，
      // 停止改用 Agent 级 cancel（见 stopChild），句柄只当快路径。
      runs: {},
      registryLoaded: false,
    }

    function ossutilPlatforms() {
      const v = OSSUTIL_VERSION
      const posix = '~/bin/ossutil'
      const win = '~/bin/ossutil.exe'
      return {
        'darwin-arm64': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-mac-arm64.zip', sha256: '10ece4d328c5d2440833adc5f4167168e9b2a4c5d364f673b0c45bcc4fd02ec5', member: 'ossutil', archive: 'zip', target: posix },
        'darwin-x64': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-mac-amd64.zip', sha256: '9cf82a53fe24d8b5cc3dfb441787e0ea19c24dd7a1246653d5f1a28b7923d6fe', member: 'ossutil', archive: 'zip', target: posix },
        'linux-x64': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-linux-amd64.zip', sha256: 'dcc512e4a893e16bbee63bc769339d8e56b21744fd83c8212a9d8baf28767343', member: 'ossutil', archive: 'zip', target: posix },
        'linux-arm64': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-linux-arm64.zip', sha256: 'f612c2a88d4d28363e254168d521fac5df632f2547ba84eaebacf6497dc04d57', member: 'ossutil', archive: 'zip', target: posix },
        'linux-arm': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-linux-arm.zip', sha256: 'ffe8b479e5fd3c0e146a14cd32e8ef5736d23f6c8de157944288ee09db2d7b1d', member: 'ossutil', archive: 'zip', target: posix },
        'linux-ia32': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-linux-386.zip', sha256: 'f8a4a7e1df8529b06a3f3cca194a1c99163cb3b8ab3b5d64228c207c3ae63b86', member: 'ossutil', archive: 'zip', target: posix },
        'win32-x64': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-windows-amd64.zip', sha256: '8e9176aedc87d230ccd97dc7236b16564f2a068609ed301acdc73dc27faf7e77', member: 'ossutil.exe', archive: 'zip', target: win },
        'win32-ia32': { url: OSSUTIL_BASE + '/ossutil-v' + v + '-windows-386.zip', sha256: '772469ef02b91e893f7211acf732c2c07cd93214552ed7cf84157d3d9b9fb799', member: 'ossutil.exe', archive: 'zip', target: win },
      }
    }

    function crwuPlatforms() {
      return {
        'darwin-arm64': { url: CRWU_BASE + '/mac/crwu', sha256: '3ab83144f2fd6de2e40f6cac03a8cf1f9b6a0716db797126dfcd14111efc7040', target: '~/bin/crwu' },
        'win32-x64': { url: CRWU_BASE + '/windows/crwu.exe', sha256: '321c6775d65a5153880315800540257ae21cba346138dffbfbed2b4b5221b438', target: '~/bin/crwu.exe' },
      }
    }

    const BUILTIN_MANIFEST = {
      schema: 'crwu.env-manifest.v1',
      updatedAt: '',
      installDocUrl: DEFAULT_INSTALL_DOC,
      binaries: [
        { name: 'node', command: 'node', versionArgs: ['--version'], expect: '>=16.7', required: true, note: '最上游运行时：dws（npm 包）与 iFinD 的 Node 路径都依赖它' },
        { name: 'crwu', command: 'crwu', versionArgs: ['version'], expect: '', required: true, note: '审核编排 CLI（crwu-audit 全流程）。mac 包为 arm64；Intel mac / Linux 暂无预编译包。', platforms: crwuPlatforms() },
        { name: 'dws', command: 'dws', versionArgs: ['version'], expect: '>=0.2.14', required: true, note: '钉钉 CLI（npm 包 dingtalk-workspace-cli）' },
        { name: 'python3', command: 'python3', versionArgs: ['--version'], expect: '>=3.8', required: true, note: '技能自带脚本运行时' },
        { name: 'ossutil', command: 'ossutil', versionArgs: ['--version'], expect: '', required: true, note: '阿里云 OSS 上传（按平台自动选用对应包）', platforms: ossutilPlatforms() },
      ],
      ifindKey: {
        required: true,
        path: '~/.agents/skills/ifind-finance-data/mcp_config.json',
        field: 'auth_token',
        placeholder: 'your ifind-mcp key',
      },
      services: [
        { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true },
        { id: 'dingtalk', label: '钉钉认证', required: true },
        { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true },
      ],
      oss: {
        enabled: true, bucket: '', endpoint: '', prefix: 'crwu/audit',
        publicBaseUrl: '', ossutil: 'ossutil', probeCommand: '', extraArgs: [],
        linkMode: 'signed', linkTtl: 3600, autoUpload: true,
      },
      // 案例根目录的指定工作空间。绝不采用「父会话自己的工作空间」当默认值 ——
      // 父会话常常就开在源码仓库里（本机 crwu-ai 工作空间 = crwu-ai 仓库），
      // 照搬会把审核产物写进代码仓库。这里只认名字/路径显式命中的那个。
      workspace: {
        preferTitle: '中瑞世联工作空间',
        preferPath: '',
      },
    }

    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

    function getFs() { return ctx.get('fs') }
    function text(v) { return v === undefined || v === null ? '' : String(v) }
    function arr(v) { return Array.isArray(v) ? v : [] }
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

    function pick(source, keys) {
      if (!source || typeof source !== 'object') return undefined
      for (let i = 0; i < keys.length; i += 1) {
        const value = source[keys[i]]
        if (value !== undefined && value !== null) return value
      }
      return undefined
    }

    function labelOf(v) {
      if (v === null || v === undefined) return ''
      if (typeof v === 'string') return v
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      if (typeof v === 'object') {
        const inner = v.label !== undefined ? v.label : (v.name !== undefined ? v.name : (v.value !== undefined ? v.value : v.title))
        return inner === undefined ? '' : String(inner)
      }
      return ''
    }

    function labels(v) { return arr(v).map(labelOf).filter(Boolean) }

    function quoteArg(value) {
      const s = String(value)
      if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
      return "'" + s.split("'").join("'\\''") + "'"
    }

    function bytesToBase64(bytes) {
      let out = ''
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i]
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
        out += B64.charAt(b0 >> 2)
        out += B64.charAt(((b0 & 3) << 4) | (b1 >> 4))
        out += i + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '='
        out += i + 2 < bytes.length ? B64.charAt(b2 & 63) : '='
      }
      return out
    }

    function mimeOf(name) {
      const n = text(name).toLowerCase()
      if (n.slice(-4) === '.png') return 'image/png'
      if (n.slice(-4) === '.jpg' || n.slice(-5) === '.jpeg') return 'image/jpeg'
      if (n.slice(-4) === '.gif') return 'image/gif'
      if (n.slice(-5) === '.webp') return 'image/webp'
      if (n.slice(-4) === '.bmp') return 'image/bmp'
      return ''
    }

    function failureMessage(error) {
      return error && error.message ? String(error.message) : String(error)
    }

    function parseVersion(value) {
      const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text(value))
      if (!m) return null
      return [Number(m[1]), Number(m[2]), Number(m[3] || 0)]
    }

    function cmpVersion(a, b) {
      for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1 }
      return 0
    }

    function satisfies(actualText, expect) {
      const e = text(expect).trim()
      if (!e || e === '*') return { ok: true, reason: '' }
      const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(e)
      const op = m && m[1] ? m[1] : '='
      const want = parseVersion(m ? m[2] : e)
      if (!want) return { ok: true, reason: '' }
      const got = parseVersion(actualText)
      if (!got) return { ok: false, reason: '无法从命令输出解析出版本号' }
      const c = cmpVersion(got, want)
      if (op === '>=') return { ok: c >= 0, reason: c >= 0 ? '' : '低于期望 ' + e }
      if (op === '>') return { ok: c > 0, reason: c > 0 ? '' : '未高于 ' + e }
      if (op === '<=') return { ok: c <= 0, reason: c <= 0 ? '' : '高于期望 ' + e }
      if (op === '<') return { ok: c < 0, reason: c < 0 ? '' : '低于期望 ' + e }
      return { ok: c === 0, reason: c === 0 ? '' : '与期望 ' + e + ' 不一致（实际 ' + text(actualText).trim() + '）' }
    }

    async function sessionRoot() {
      if (state.sessionRoot) return state.sessionRoot
      const f = getFs()
      if (f === undefined) return ''
      try {
        const target = await f.resolve('.')
        state.sessionRoot = text(target.displayPath)
      } catch (error) { state.sessionRoot = '' }
      return state.sessionRoot
    }

    async function runShell(command, workdir, timeoutMs, escalate, stdoutMaxBytes, stdinText) {
      const shell = ctx.get('shell')
      if (shell === undefined) return { ok: false, error: 'Host shell 服务不可用' }
      const workRoot = workdir || await sessionRoot()
      if (escalate && !workRoot) return { ok: false, error: '未知会话工作区，无法申请无沙箱执行' }
      const spec = shell.resolve({
        command: command,
        workdir: workRoot || undefined,
        timeoutMs: timeoutMs || 60000,
        stdoutMaxBytes: stdoutMaxBytes || 65536,
        stdin: stdinText === undefined ? undefined : stdinText,
        sandboxPolicy: escalate ? { mode: 'danger-full-access', workspaceRoot: workRoot } : undefined,
      })
      let res
      try {
        res = await shell.run(spec)
      } catch (error) {
        return { ok: false, error: '执行失败：' + failureMessage(error) }
      }
      return {
        ok: res && res.exitCode === 0,
        exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : null,
        stdout: text(res && res.stdout && res.stdout.text),
        stderr: text(res && res.stderr && res.stderr.text),
        truncated: !!(res && res.stdout && res.stdout.truncated) || !!(res && res.stderr && res.stderr.truncated),
        timedOut: !!(res && res.timedOut),
        sandbox: res && res.sandbox && typeof res.sandbox === 'object' ? { mode: text(res.sandbox.mode), denied: res.sandbox.denied === true } : null,
      }
    }

    async function homeDir() {
      if (state.home) return state.home
      const probes = [
        'node -p \'require("os").homedir()\'',
        'python3 -c \'import os;print(os.path.expanduser("~"))\'',
        'printf %s "$HOME"',
        'Write-Output $env:USERPROFILE',
      ]
      for (let i = 0; i < probes.length; i += 1) {
        const run = await runShell(probes[i], undefined, 15000, false)
        const out = text(run.stdout).trim().split('\n')[0].trim()
        if (run.ok === true && out) { state.home = out; return out }
      }
      state.home = ''
      return ''
    }

    function normalizePlatform(raw) {
      const first = text(raw).trim().split('\n')[0].trim()
      if (!first) return ''
      const toks = first.toLowerCase().replace(/\s+/g, '-').split('-').filter(Boolean)
      if (toks.length === 0) return ''
      let os = toks[0]
      let arch = toks.length > 1 ? toks[1] : ''
      if (os === 'darwin' || os === 'mac' || os === 'macos') os = 'darwin'
      else if (os.indexOf('win') === 0) os = 'win32'
      else if (os === 'linux') os = 'linux'
      else return ''
      if (arch === 'x86_64' || arch === 'amd64') arch = 'x64'
      else if (arch === 'aarch64') arch = 'arm64'
      else if (arch === 'i386' || arch === 'i686' || arch === 'x86') arch = 'ia32'
      return os + (arch ? '-' + arch : '')
    }

    async function detectPlatform() {
      if (state.platform) return state.platform
      const probes = [
        'node -p \'process.platform+"-"+process.arch\'',
        'node -p \'process.platform\'',
        'python3 -c \'import sys,platform;print(sys.platform+"-"+platform.machine())\'',
        'uname -sm',
      ]
      for (let i = 0; i < probes.length; i += 1) {
        const run = await runShell(probes[i], undefined, 20000, false)
        if (run.ok !== true) continue
        const norm = normalizePlatform(run.stdout)
        if (norm) { state.platform = norm; return norm }
      }
      state.platform = ''
      return ''
    }

    function resolveEntry(entry, platform) {
      const base = entry && typeof entry === 'object' ? entry : {}
      const plats = base.platforms && typeof base.platforms === 'object' ? base.platforms : null
      if (!plats) return base
      const os = text(platform).split('-')[0]
      const chosen = plats[platform] || plats[os] || plats['default'] || null
      if (!chosen) return Object.assign({}, base, { url: '', sha256: '', archive: '', member: '', target: '' })
      return Object.assign({}, base, {
        url: text(chosen.url),
        sha256: text(chosen.sha256),
        target: text(chosen.target) || text(base.target),
        archive: text(chosen.archive) || text(base.archive),
        member: text(chosen.member) || text(base.member),
      })
    }

    function expandLocal(p, home, isWin) {
      const s = text(p)
      if (!home) return s
      if (s === '~') return home
      if (s.indexOf('~/') === 0 || s.indexOf('~\\') === 0) {
        return home.replace(/[\\/]+$/, '') + (isWin ? '\\' : '/') + s.slice(2)
      }
      return s
    }

    function buildInstallPromptText(url, workspacePath) {
      const L = []
      L.push('请完成本机 crwu 审核环境的安装。')
      L.push('')
      L.push('**第一步：先完整阅读这份安装清单 —— ' + text(url) + '**')
      L.push('')
      L.push('然后**严格按它的步骤逐条执行**。不要凭经验跳步，不要自己发明安装方式；清单里的下载地址、校验要求、目录约定、硬性约束都以它为准。')
      L.push('')
      L.push('几条必须遵守的：')
      L.push('1. **先检查、只装缺的**：已经装好且可用的项直接跳过，不要重装。')
      L.push('2. **GitHub 一律按不可达处理**：不要尝试、不要兜底、不要试探连通性。需要的东西只能从 GitHub 获得时停下来问我。')
      L.push('3. **密钥、令牌一律不要回显**到对话或日志里。')
      L.push('4. **每一项都要实际验证**（跑版本命令、看真实输出），不要凭推理判断成功。')
      if (text(workspacePath)) {
        L.push('5. 需要临时文件时放在当前工作空间 `' + text(workspacePath) + '` 下，不要写系统目录。')
      }
      L.push('')
      L.push('完成后**逐项回报**：每项的实际状态（新装/已存在）、实际下载地址、安装后的绝对路径、验证命令的真实输出；以及任何跳过或失败的项目和原因。')
      return L.join('\n')
    }

    function checkIfindToken(raw, placeholder) {
      const s = text(raw)
      const ph = text(placeholder) || 'your ifind-mcp key'
      if (!s.trim()) return { ok: false, reason: 'auth_token 为空' }
      if (s.trim().toLowerCase() === ph.toLowerCase()) return { ok: false, reason: 'auth_token 仍是占位符 ' + ph }
      if (s !== s.trim()) return { ok: false, reason: 'auth_token 含首尾空白，需要清洗' }
      return { ok: true, reason: '', tokenLength: s.length }
    }

    async function probeIfindKey(manifest, home) {
      const spec = manifest.ifindKey && typeof manifest.ifindKey === 'object' ? manifest.ifindKey : null
      if (!spec) return null
      const isWin = text(state.platform).indexOf('win32') === 0
      const path = expandLocal(text(spec.path), home, isWin)
      const out = { path: path, required: spec.required !== false, ok: false, reason: '', tokenLength: 0 }
      const f = getFs()
      if (f === undefined) { out.reason = 'Host 文件服务不可用'; return out }
      try {
        const target = await resolvePath(path)
        const info = await f.stat(target)
        if (!info || info.type !== 'file') { out.reason = '配置文件不存在（技能可能尚未安装）'; return out }
        const doc = parseJsonLoose(await f.readText(target))
        if (!doc || typeof doc !== 'object') { out.reason = '配置文件不是合法 JSON'; return out }
        const raw = doc[text(spec.field) || 'auth_token']
        const verdict = checkIfindToken(raw, spec.placeholder)
        out.ok = verdict.ok
        out.reason = verdict.reason
        out.tokenLength = verdict.tokenLength || 0
      } catch (error) {
        out.reason = '读取失败：' + failureMessage(error)
      }
      return out
    }

    async function defaultRoot() {
      if (state.root) return state.root
      const f = getFs()
      if (f === undefined) return ''
      try {
        const preferred = await f.resolve(DEFAULT_CASE_ROOT)
        const info = await f.stat(preferred)
        if (info && info.type === 'directory') {
          state.root = text(preferred.displayPath)
          return state.root
        }
      } catch (error) { /* 回退 */ }
      state.root = await sessionRoot()
      return state.root
    }

    async function resolvePath(path, cwd) {
      const f = getFs()
      if (f === undefined) throw new Error('Host 文件服务不可用')
      return await f.resolve(path, cwd ? { cwd: cwd } : undefined)
    }

    function dirMarker(name) {
      if (name.indexOf('材料-源') === 0) return 'materials'
      if (name.indexOf('工作版') === 0) return 'work'
      if (name.indexOf('复核-人工') === 0) return 'review'
      if (name.indexOf('媒体证据') === 0) return 'media'
      if (name === 'knowledge') return 'knowledge'
      if (name === 'raw') return 'raw'
      if (name === 'findings') return 'findings'
      if (name === '解压') return 'extracted'
      if (name === '提取') return 'extract'
      return ''
    }

    function fileMarker(name) {
      if (name === '排除清单.json') return 'excluded'
      if (name === '材料盘点.json') return 'inventory'
      if (name === '媒体索引.json') return 'mediaIndex'
      if (name === '复核盘点.json') return 'reviewInventory'
      if (name === '复核媒体索引.json') return 'reviewMediaIndex'
      if (name === '复核对照.json') return 'reviewCompare'
      if (name === '冻结指纹.json' || name === '冻结快照.json') return 'frozen'
      if (name === 'route_profile.json' || name === 'route_dispatch.json') return 'routeProfile'
      return ''
    }

    const COUNTED = { materials: true, media: true, knowledge: true, review: true, work: true, findings: true, raw: true }

    function extractAuditSummary(doc) {
      const root = doc && typeof doc === 'object' ? doc : {}
      const at = root.auditTask && typeof root.auditTask === 'object' ? root.auditTask : {}
      const prof = at.profile && typeof at.profile === 'object' ? at.profile : {}
      const rp = prof.routeProfile && typeof prof.routeProfile === 'object' ? prof.routeProfile : {}
      const counts = root.summary && root.summary.counts && typeof root.summary.counts === 'object' ? root.summary.counts : {}
      const rc = root.reviewComparison && typeof root.reviewComparison === 'object' ? root.reviewComparison : {}
      const m = rc.metrics && typeof rc.metrics === 'object' ? rc.metrics : null
      const pc = root.phaseControl && typeof root.phaseControl === 'object' ? root.phaseControl : {}
      const ft = root.fileTrace && typeof root.fileTrace === 'object' ? root.fileTrace : {}
      const hitRate = m ? m.aiHitRate : undefined
      let derivedHitRate = ''
      if (m && (hitRate === undefined || hitRate === null || hitRate === '')) {
        const evaluable = num(m.evaluable)
        if (evaluable > 0) derivedHitRate = ((num(m.exactHits) + num(m.partialHits)) / evaluable * 100).toFixed(1) + '%'
      }
      return {
        projectId: text(at.projectId),
        reportVersion: text(at.reportVersion),
        auditTime: text(at.auditTime),
        engineVersion: text(at.engineVersion),
        overallDecision: text(root.summary ? root.summary.overallDecision : ''),
        counts: {
          issuesTotal: num(counts.issuesTotal), fail: num(counts.fail),
          high: num(counts.high), medium: num(counts.medium), low: num(counts.low),
          pendingConfirmation: num(counts.pendingConfirmation), notChecked: num(counts.notChecked),
        },
        axes: {
          objectType: text(prof.objectType),
          scenario: text(prof.scenario),
          stage: text(prof.stage),
          reportForm: text(pick(rp, ['reportForm', 'report_form'])),
          riskClass: text(pick(rp, ['reviewRiskClass', 'review_risk_class'])),
          methods: labels(pick(prof, ['methods'])),
          scope: labels(pick(rp, ['scopeTypes', 'scope_types'])),
          asset: labels(pick(rp, ['assetTypes', 'asset_types'])),
          business: labels(pick(rp, ['businessTypes', 'business_types'])),
          routeMethods: labels(pick(rp, ['methods'])),
          overlays: labels(pick(rp, ['overlays'])),
          skills: labels(pick(rp, ['skillsToLoad', 'skills_to_load'])),
        },
        review: {
          status: text(rc.status) || 'not_performed',
          bands: rc.bands && typeof rc.bands === 'object' ? {
            overlap: num(rc.bands.overlap), aiOnly: num(rc.bands.aiOnly),
            divergent: num(rc.bands.divergent), reviewerOnly: num(rc.bands.reviewerOnly),
          } : null,
          metrics: m ? {
            total: num(m.total), resolved: num(m.resolved), uncheckable: num(m.uncheckable),
            evaluable: num(m.evaluable), exactHits: num(m.exactHits), partialHits: num(m.partialHits),
            misses: num(m.misses), aiHitRate: text(hitRate), derivedHitRate: derivedHitRate,
          } : null,
        },
        phase: {
          phase1FrozenAt: text(pc.phase1FrozenAt),
          reviewAccessedAt: text(pc.reviewAccessedAt),
          phase2CompletedAt: text(pc.phase2CompletedAt),
        },
        generatedAt: text(ft.generatedAt),
        rendererVersion: text(ft.rendererVersion),
      }
    }

    async function inspectCase(dirTarget) {
      const f = getFs()
      if (f === undefined) return null
      let entries = []
      try { entries = await f.listDir(dirTarget) } catch (error) { return null }
      const display = text(dirTarget.displayPath)
      const trimmed = display.replace(/\/+$/, '')
      const parts = trimmed.split('/')
      const name = parts.length > 0 ? parts[parts.length - 1] : trimmed
      const canonicalHtml = '审核意见.' + name + '.html'
      const flags = {}
      const dirCounts = {}
      let resultFile = ''
      let htmlFile = ''
      let htmlRank = -1
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]
        if (entry.type === 'directory') {
          const key = dirMarker(entry.name)
          if (!key) continue
          flags[key] = true
          if (COUNTED[key]) {
            let count = 0
            try { count = (await f.listDir(entry.target)).length } catch (error) { count = 0 }
            dirCounts[key] = num(dirCounts[key]) + count
          }
          continue
        }
        if (entry.type !== 'file') continue
        const fm = fileMarker(entry.name)
        if (fm) { flags[fm] = true; continue }
        if (/^审核结果\..+\.json$/.test(entry.name)) { flags.result = true; resultFile = entry.name; continue }
        if (/^审核意见\..+\.html$/.test(entry.name)) {
          flags.html = true
          let rank = 1
          if (entry.name === canonicalHtml) rank = 3
          else if (entry.name.indexOf('.before-') < 0) rank = 2
          if (rank > htmlRank) { htmlRank = rank; htmlFile = entry.name }
          continue
        }
      }
      const isCase = flags.materials || flags.inventory || flags.result || flags.review || flags.knowledge || flags.raw || flags.html
      if (!isCase) return null
      const item = { name: name, path: display, flags: flags, dirCounts: dirCounts, resultFile: resultFile, htmlFile: htmlFile, audit: null, error: '' }
      if (resultFile) {
        try {
          const target = await resolvePath(resultFile, item.path)
          item.audit = extractAuditSummary(JSON.parse(await f.readText(target)))
        } catch (error) { item.error = failureMessage(error) }
      }
      return item
    }

    async function listFilesUnder(dirPath, depth) {
      const f = getFs()
      const out = []
      if (f === undefined) return out
      async function walk(current, remaining) {
        let target
        try { target = await f.resolve(current) } catch (error) { return }
        let entries = []
        try { entries = await f.listDir(target) } catch (error) { return }
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i]
          if (entry.type === 'file') out.push({ name: entry.name, path: text(entry.target.displayPath), size: num(entry.size) })
          else if (entry.type === 'directory' && remaining > 0) await walk(text(entry.target.displayPath), remaining - 1)
        }
      }
      await walk(dirPath, depth)
      return out
    }

    function keychainBlocked(res) {
      const blob = (text(res && res.stderr) + ' ' + text(res && res.stdout)).toLowerCase()
      return blob.indexOf('credential store') >= 0 || blob.indexOf('auto-refresh failed') >= 0 || blob.indexOf('exit status 161') >= 0
    }

    function describeFailure(run) {
      if (run && run.error) return run.error
      if (run && run.truncated) {
        return '命令输出被宿主截断（stdout 上限），返回内容不是完整 JSON。'
      }
      if (keychainBlocked(run)) {
        return '氚云会话自动续期需要把新令牌写回系统钥匙串，当前沙箱策略拒绝写入。这不是凭据过期，也不是氚云侧故障。'
      }
      const err = text(run && run.stderr).trim()
      if (err) return err.slice(0, 500)
      const out = text(run && run.stdout).trim()
      if (out) return '命令未返回 JSON，原始输出：' + out.slice(0, 500)
      return '命令没有任何输出（退出码 ' + (run && run.exitCode !== null && run.exitCode !== undefined ? run.exitCode : '未知') + '）'
    }

    function escalationAllowed(clean) {
      if (clean[1] !== 'h3yun') return false
      const sub = clean[2]
      if (sub === 'session') return clean[3] === 'login'
      return sub === 'forms' || sub === 'records' || sub === 'apps' || sub === 'files' || sub === 'file' || sub === 'tools'
    }

    async function runCrwu(argv, workdir, timeoutMs, escalate, stdoutMaxBytes) {
      if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: '缺少命令' }
      const clean = argv.map(text)
      if (clean[0] !== 'crwu') return { ok: false, error: '工作台只允许调用 crwu 命令' }
      const allowed = escalationAllowed(clean)
      const effective = escalate === true || (state.trustH3yun === true && allowed)
      if (escalate === true && !allowed) {
        return { ok: false, error: '该 crwu 子命令不允许无沙箱执行：' + clean.slice(0, 3).join(' ') }
      }
      const run = await runShell(clean.map(quoteArg).join(' '), workdir, timeoutMs, effective, stdoutMaxBytes)
      const blocked = keychainBlocked(run)
      return {
        ok: run.ok === true,
        exitCode: run.exitCode,
        stdout: text(run.stdout),
        stderr: text(run.stderr),
        truncated: run.truncated === true,
        timedOut: run.timedOut === true,
        sandbox: run.sandbox || null,
        error: run.error || '',
        escalated: effective === true,
        keychainBlocked: blocked,
        escalateAvailable: blocked === true && effective !== true && allowed,
      }
    }

    function parseJsonLoose(value) {
      try { return JSON.parse(value) } catch (error) { return null }
    }

    function normalizeOss(doc) {
      const base = doc && typeof doc === 'object' ? doc : {}
      const lm = text(base.linkMode)
      return {
        enabled: base.enabled === true,
        bucket: text(base.bucket),
        endpoint: text(base.endpoint),
        prefix: (text(base.prefix) || 'crwu/audit').replace(/\/+$/, ''),
        publicBaseUrl: text(base.publicBaseUrl),
        ossutil: text(base.ossutil) || 'ossutil',
        probeCommand: text(base.probeCommand),
        extraArgs: arr(base.extraArgs).map(text),
        linkMode: lm === 'public' ? 'public' : 'signed',
        linkTtl: num(base.linkTtl) > 0 ? Math.floor(num(base.linkTtl)) : 3600,
        autoUpload: base.autoUpload !== false,
      }
    }

    function normalizeManifest(doc) {
      const base = doc && typeof doc === 'object' ? doc : {}
      const binaries = arr(base.binaries).map((entry) => ({
        name: text(entry.name),
        command: text(entry.command) || text(entry.name),
        versionArgs: arr(entry.versionArgs).map(text).length > 0 ? arr(entry.versionArgs).map(text) : ['version'],
        expect: text(entry.expect),
        url: text(entry.url),
        sha256: text(entry.sha256),
        target: text(entry.target),
        archive: text(entry.archive),
        member: text(entry.member),
        platforms: entry.platforms && typeof entry.platforms === 'object' ? entry.platforms : null,
        required: entry.required !== false,
        note: text(entry.note),
      })).filter((entry) => entry.name)
      const services = arr(base.services).length > 0
        ? arr(base.services).map((s) => ({ id: text(s.id), label: text(s.label), required: s.required !== false }))
        : BUILTIN_MANIFEST.services
      const ik = base.ifindKey && typeof base.ifindKey === 'object' ? base.ifindKey : null
      return {
        schema: text(base.schema) || 'crwu.env-manifest.v1',
        updatedAt: text(base.updatedAt),
        installDocUrl: text(base.installDocUrl) || DEFAULT_INSTALL_DOC,
        binaries: binaries.length > 0 ? binaries : BUILTIN_MANIFEST.binaries,
        ifindKey: ik ? {
          required: ik.required !== false,
          path: text(ik.path) || BUILTIN_MANIFEST.ifindKey.path,
          field: text(ik.field) || 'auth_token',
          placeholder: text(ik.placeholder) || 'your ifind-mcp key',
        } : BUILTIN_MANIFEST.ifindKey,
        services: services,
        oss: normalizeOss(Object.assign({}, BUILTIN_MANIFEST.oss, base.oss)),
        workspace: {
          preferTitle: text((base.workspace && base.workspace.preferTitle)) || BUILTIN_MANIFEST.workspace.preferTitle,
          preferPath: text((base.workspace && base.workspace.preferPath)) || BUILTIN_MANIFEST.workspace.preferPath,
        },
      }
    }

    async function loadManifest(source) {
      const src = text(source) || state.manifestSource || DEFAULT_MANIFEST_SOURCE
      state.manifestSource = src
      if (!/^https?:\/\//i.test(src)) {
        return {
          manifest: normalizeManifest(BUILTIN_MANIFEST), source: src, kind: 'invalid', loaded: false,
          error: '清单地址必须是 http(s) 远程地址（本版不在本地留数据）；已回退到内置默认清单。',
        }
      }
      const run = await runShell('curl -fsSL --max-time 25 ' + quoteArg(src), undefined, 45000, false, 4 * 1024 * 1024)
      if (!run.ok) {
        return { manifest: normalizeManifest(BUILTIN_MANIFEST), source: src, kind: 'url', loaded: false, error: '远程清单拉取失败：' + (run.stderr || run.error || '').slice(0, 300) + '（已回退到内置默认清单）' }
      }
      const doc = parseJsonLoose(run.stdout)
      if (!doc) return { manifest: normalizeManifest(BUILTIN_MANIFEST), source: src, kind: 'url', loaded: false, error: '远程清单不是合法 JSON（已回退到内置默认清单）' }
      return { manifest: normalizeManifest(doc), source: src, kind: 'url', loaded: true, error: '' }
    }

    function stripPrefix(key, prefix) {
      const p = text(prefix).replace(/^\/+|\/+$/g, '')
      const k = text(key)
      if (!p) return k
      if (k === p) return ''
      if (k.indexOf(p + '/') === 0) return k.slice(p.length + 1)
      return ''
    }

    function seqNoFromKey(key, prefix) {
      const rel = stripPrefix(key, prefix)
      const parts = rel.split('/').filter(Boolean)
      if (parts.length >= 3 && /^\d{4}-\d+-/.test(parts[2])) return parts[2]
      const all = text(key).split('/').filter(Boolean)
      for (let i = 0; i < all.length; i += 1) {
        if (/^\d{4}-\d+-/.test(all[i])) return all[i]
      }
      return ''
    }

    function parseLsObjects(out, bucket) {
      const keys = []
      const lines = text(out).split(/\r?\n/)
      const prefix = 'oss://' + bucket + '/'
      for (let i = 0; i < lines.length; i += 1) {
        const s = lines[i].trim()
        if (!s) continue
        let key = ''
        if (s.indexOf(prefix) === 0) key = s.slice(prefix.length)
        else if (s.indexOf('oss://') === 0) {
          const rest = s.slice('oss://'.length)
          const idx = rest.indexOf('/')
          if (idx < 0) continue
          key = rest.slice(idx + 1)
        } else continue
        if (key) keys.push(key)
      }
      return keys
    }

    function parseSignUrl(out) {
      const lines = text(out).split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const s = lines[i].trim()
        if (/^https?:\/\//i.test(s)) return s
      }
      return ''
    }

    function fileNameOf(key) { const p = text(key).split('/'); return p.length > 0 ? p[p.length - 1] : '' }

    async function resolveOssutil(oss, platform) {
      const probe = await runShell('command -v ' + quoteArg(oss.ossutil) + ' 2>/dev/null || true', undefined, 15000, false)
      let p = text(probe.stdout).trim()
      if (p) return p
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const entry = arr(manifest.binaries).filter((e) => text(e.name) === 'ossutil')[0]
      if (entry) {
        const res = resolveEntry(entry, platform)
        if (res.target) {
          const candidate = expandLocal(res.target, await homeDir(), platform.indexOf('win32') === 0)
          try {
            const info = await getFs().stat(await resolvePath(candidate))
            if (info && info.type === 'file') p = candidate
          } catch (error) { /* 未安装 */ }
        }
      }
      return p
    }

    async function probeEnv(manifest, platform) {
      const entries = arr(manifest.binaries)
      const commands = entries.map((e) => text(e.command)).filter((c) => /^[A-Za-z0-9._-]+$/.test(c))
      const paths = {}
      if (commands.length > 0) {
        const script = 'for b in ' + commands.join(' ') + '; do p=$(command -v "$b" 2>/dev/null); printf "%s\\t%s\\n" "$b" "$p"; done'
        const run = await runShell(script, undefined, 30000, false)
        text(run.stdout).split('\n').forEach((line) => {
          const idx = line.indexOf('\t')
          if (idx > 0) paths[line.slice(0, idx)] = line.slice(idx + 1).trim()
        })
      }
      const checks = []
      const f = getFs()
      const home = await homeDir()
      const isWin = text(platform).indexOf('win32') === 0
      for (let i = 0; i < entries.length; i += 1) {
        const entry = resolveEntry(entries[i], platform)
        let found = text(paths[entry.command])
        if (!found && entry.target) {
          try {
            const t = await resolvePath(expandLocal(entry.target, home, isWin))
            const info = f ? await f.stat(t) : undefined
            if (info && info.type === 'file') found = text(t.displayPath)
          } catch (error) { /* 目标不存在 */ }
        }
        let versionText = ''
        if (found) {
          const args = arr(entry.versionArgs).map(quoteArg).join(' ')
          const run = await runShell(quoteArg(found) + (args ? ' ' + args : ''), undefined, 30000, false)
          versionText = (text(run.stdout) + '\n' + text(run.stderr)).trim().split('\n')[0]
        }
        const verdict = found ? satisfies(versionText, entry.expect) : { ok: false, reason: '未安装' }
        checks.push({
          name: entry.name, command: entry.command, required: entry.required !== false, note: entry.note,
          found: !!found, path: found, versionText: versionText,
          actual: versionText ? (parseVersion(versionText) || []).join('.') : '',
          expect: entry.expect, ok: !!found && verdict.ok, reason: verdict.reason || '',
          url: entry.url, sha256: entry.sha256, target: entry.target,
        })
      }
      return checks
    }

    async function probeOss(oss, required, platform) {
      const base = { id: 'oss', label: '阿里云 OSS（AK 权限）', required: required !== false }
      if (!oss.enabled) return Object.assign({}, base, { ok: false, state: '未启用', detail: '清单 oss.enabled 为 false' })
      if (!oss.bucket) return Object.assign({}, base, { ok: false, state: '缺 bucket', detail: '清单 oss.bucket 为空' })
      const ossutilPath = await resolveOssutil(oss, platform)
      if (!ossutilPath) {
        return Object.assign({}, base, { ok: false, state: 'ossutil 未安装', detail: '请复制安装提示词交给 Agent。' })
      }
      const endpointArg = oss.endpoint ? ' --endpoint ' + quoteArg(oss.endpoint) : ''
      const cmd = oss.probeCommand
        ? oss.probeCommand.split('{ossutil}').join(quoteArg(ossutilPath)).split('{bucket}').join(oss.bucket).split('{endpoint}').join(oss.endpoint)
        : quoteArg(ossutilPath) + ' ls ' + quoteArg('oss://' + oss.bucket + '/') + endpointArg + ' --limited-num 1'
      const run = await runShell(cmd, undefined, 60000, false)
      const raw = (text(run.stderr) || text(run.stdout) || text(run.error) || '探测失败').trim()
      let st = 'AK 配置有误或不可用'
      if (run.ok === true) st = 'AK 正常'
      else if (raw.indexOf('AccessDenied') >= 0 || raw.indexOf('denied') >= 0) st = 'AK 无权限'
      else if (raw.indexOf('InvalidAccessKeyId') >= 0 || raw.indexOf('SignatureDoesNotMatch') >= 0) st = 'AK 无效'
      else if (raw.indexOf('NoSuchBucket') >= 0) st = 'bucket 不存在'
      else if (raw.toLowerCase().indexOf('both empty') >= 0) st = 'AK 未配置'
      return Object.assign({}, base, {
        ok: run.ok === true, state: st,
        detail: run.ok === true
          ? ('AK 可访问 oss://' + oss.bucket + '/' + (oss.endpoint ? ' @ ' + oss.endpoint : ''))
          : (raw.slice(0, 400)),
      })
    }

    function rowsFromEnvelope(payload) {
      const data = payload && typeof payload === 'object' && payload.data !== undefined ? payload.data : payload
      if (Array.isArray(data)) return data
      if (data && typeof data === 'object') {
        if (Array.isArray(data.returnData)) return data.returnData
        if (Array.isArray(data.rows)) return data.rows
        if (Array.isArray(data.items)) return data.items
      }
      return []
    }

    function totalFromEnvelope(payload) {
      const data = payload && typeof payload === 'object' ? payload.data : undefined
      if (!data || typeof data !== 'object') return 0
      return num(pick(data, ['dataCount', 'total', 'count']))
    }

    function buildQueryFilter(query) {
      const q = text(query).trim()
      if (!q) return { expr: '', mode: '' }
      if (/['\\]/.test(q)) return { expr: '', mode: 'invalid' }
      if (SEQ_NO_FULL.test(q)) return { expr: "SeqNo Equal '" + q + "'", mode: 'equal' }
      return { expr: "SeqNo Contains '" + q + "'", mode: 'contains' }
    }

    function rowToTask(row) {
      const r = row && typeof row === 'object' ? row : {}
      const id = text(pick(r, ['ObjectId', 'objectId', 'Id', 'id']))
      return {
        name: text(pick(r, ['Name', 'name', 'Title'])) || '（无标题）',
        project: text(pick(r, ['F0000049'])),
        business: text(pick(r, ['F0000056'])),
        risk: text(pick(r, ['F0000020'])),
        seqNo: text(pick(r, ['SeqNo', 'seqNo'])),
        status: r.Status === undefined || r.Status === null ? '' : String(r.Status),
        statusName: text(pick(r, ['Status_Name', 'statusName'])),
        modifiedAt: text(pick(r, ['ModifiedTime', 'modifiedTime', 'CreatedTime', 'createdTime'])),
        id: id,
        idTail: id.length > 8 ? id.slice(-8) : id,
      }
    }

    function sessionView(doc) {
      const data = doc && doc.data && typeof doc.data === 'object' ? doc.data : null
      if (!data) return null
      return { userId: text(data.userId), expiresAt: text(data.expiresAt), expiresIn: text(data.expiresIn) }
    }

    async function discoverForm(keyword, escalate) {
      const run = await runCrwu(['crwu', 'h3yun', 'forms', 'search', '--keyword', keyword], undefined, 60000, escalate)
      const payload = parseJsonLoose(run.stdout)
      if (!payload) {
        return { ok: false, error: describeFailure(run), run: run }
      }
      const list = rowsFromEnvelope(payload)
      const isForm = (f) => text(f.nodeType) === '200' || text(f.nodeType) === '210'
      const exact = list.filter((f) => text(f.displayName) === keyword && isForm(f))[0]
      const anyForm = list.filter(isForm)[0]
      const form = exact || anyForm
      if (!form) return { ok: false, error: '未在氚云定位到表单「' + keyword + '」', run: run }
      return { ok: true, code: text(form.code), name: text(form.displayName), run: run }
    }

    function auditPrompt(task) {
      const ws = text(task.workspace).replace(/\/+$/, '')
      const seq = text(task.seqNo)
      const caseDir = ws && seq ? (ws + '/' + seq) : ''
      const L = [
        '请审核这条评估报告：氚云报告审核记录 ObjectId「' + (task.objectId || '缺失') + '」，报告流水号「' + seq + '」，项目名称「' + (task.project || '') + '」。',
        '',
      ]
      if (caseDir) {
        // 子会话的 cwd 只能继承父会话（startInProcessRun 用 childSessionMeta(parent) 构造，
        // 没有覆盖入口），所以插件无法用 cwd 表达"在工作空间里做"，
        // 只能把绝对路径写进指令，由技能按绝对路径作业。
        L.push('**本案例的唯一根目录是：' + ws + '**')
        L.push('**本案例目录必须是：' + caseDir + '**')
        L.push('')
        L.push('硬性要求：')
        L.push('1. 材料、中间产物、交付件全部放在上述案例目录下。')
        L.push('2. 技能脚本的 `--case` 参数一律传这个**绝对路径**，不要传相对路径。')
        L.push('3. **不要**在当前工作目录下创建案例目录，也**不要**使用其他默认根目录。')
        L.push('')
      }
      if (task.isRetry === true) {
        // 重新审核必须是干净的一遍。案例目录里往往躺着上一轮的
        // findings/、审核意见.*.json、冻结快照、材料盘点……如果让子会话
        // 参照它们，等于把上一轮的结论复制一遍，重审就没意义了。
        L.push('## 这是**重新审核**，不是接着上一轮继续')
        L.push('')
        L.push('请把这条报告当成一次**全新的审核**，从零重跑完整两阶段流程：')
        L.push('1. **不要参考、不要复用、不要读取**案例目录里上一轮留下的任何产物 —— 包括 `findings/`、`审核意见.*.json`、`审核意见.*.html`、`审核结果.*.json`、`冻结快照.json`、`冻结指纹.json`、`材料盘点.json`、`媒体索引.json`、`route_profile.json` 等。以它们的**文件名**判断即可，不要打开。')
        L.push('2. **材料重新从氚云取**，不要拿目录里已有的旧副本当输入。')
        L.push('3. 中间产物与交付件直接覆盖上一轮的旧文件，不要基于旧内容做增量更新。')
        L.push('4. 唯一例外是 `复核-人工/`：那里是人工复核记录，两阶段隔离门禁照旧，**一律不得读取**。')
        L.push('')
        L.push('如果你的流程里有任何一步会去读上述旧文件，跳过它，改按全新审核重新生成。')
        L.push('')
      }
      L.push('按 crwu-audit 技能执行完整两阶段审核流程（阶段一独立审核并冻结，再进入阶段二复核对照）。')
      const oss = task.oss && typeof task.oss === 'object' ? task.oss : null
      if (oss && oss.bucket && seq) {
        const endpointArg = oss.endpoint ? ' --endpoint ' + oss.endpoint : ''
        const keyPrefix = oss.prefix + '/' + seq
        L.push('')
        L.push('## 完成后必须把交付件上传到 OSS')
        L.push('')
        L.push('凭据已经配在本机 `~/.ossutilconfig`，直接用 `ossutil` 即可 —— **不要问我要 AccessKey，不要回显任何密钥**。参数以这里写的为准：')
        L.push('')
        L.push('- bucket：`' + oss.bucket + '`' + (oss.endpoint ? '，endpoint：`' + oss.endpoint + '`' : ''))
        L.push('- 对象前缀：`' + keyPrefix + '/`')
        L.push('')
        L.push('```bash')
        L.push('ossutil cp -f "' + caseDir + '/审核意见.' + seq + '.html" "oss://' + oss.bucket + '/' + keyPrefix + '/审核意见.' + seq + '.html"' + endpointArg)
        L.push('ossutil cp -f "' + caseDir + '/审核结果.' + seq + '.json" "oss://' + oss.bucket + '/' + keyPrefix + '/审核结果.' + seq + '.json"' + endpointArg)
        L.push('```')
        L.push('')
        L.push('要求：')
        L.push('1. **HTML 必须上传**。结果 JSON 存在就一并上传；不存在就只传 HTML，并在汇报里说明。')
        L.push('2. 上传后**实际校验**，不要只凭退出码判断：')
        L.push('')
        L.push('   ```bash')
        L.push('   ossutil ls "oss://' + oss.bucket + '/' + keyPrefix + '/"' + endpointArg)
        L.push('   ```')
        L.push('')
        L.push('   对象确实列出、大小非 0 才算成功。')
        L.push('3. 汇报里写清每一项的 `ossutil` 退出码、`oss://` 目标路径、对象大小，以及 `ls` 的真实输出。')
        L.push('4. 上传失败**不要静默略过**，把 `ossutil` 的报错原文贴出来。')
      }
      return L.join('\n')
    }

    // 沙箱里没有 AbortController，但子代理驱动的取消路径只用到 signal 的
    // aborted / reason / addEventListener('abort') / removeEventListener /
    // throwIfAborted —— 这五个成员手写就够了，并且关键是我们**自己能 abort**。
    //
    // 为什么必须自己持有 abort：dsh-subagent-in-process-driver 的取消**只**
    // 发生在调用方 signal 的 abort 事件上（onAbort → child.cancel）。而
    // run.dispose() 会先把 abort 监听摘掉、再 await result —— 拿一个不会响的
    // 信号去 dispose，等于干等审核跑完，停不下来。所以顺序必须是
    // 先 abort()，再 dispose()。
    function makeAbortableSignal() {
      const listeners = []
      const sig = {
        aborted: false,
        reason: undefined,
        onabort: null,
        throwIfAborted: function () {
          if (!sig.aborted) return
          throw (sig.reason instanceof Error ? sig.reason : new Error('subagent request aborted'))
        },
        addEventListener: function (type, listener, options) {
          if (type !== 'abort' || typeof listener !== 'function') return
          // 与真实 AbortSignal 一致：已经 abort 之后再注册的监听**不会**被补发
          // （事件已经派发过了）。需要这个语义的调用方自己查 sig.aborted ——
          // 子代理驱动就是这么写的：addEventListener 之后紧跟 if (signal.aborted) onAbort()。
          if (sig.aborted) return
          listeners.push({ fn: listener, once: !!(options && options.once) })
        },
        removeEventListener: function (type, listener) {
          if (type !== 'abort') return
          for (let i = listeners.length - 1; i >= 0; i -= 1) {
            if (listeners[i].fn === listener) listeners.splice(i, 1)
          }
        },
        dispatchEvent: function () { return false },
      }
      function abort(reason) {
        if (sig.aborted) return false
        sig.aborted = true
        sig.reason = reason === undefined ? new Error('subagent run aborted') : reason
        const pending = listeners.slice()
        listeners.length = 0
        for (let i = 0; i < pending.length; i += 1) {
          try { pending[i].fn.call(sig, { type: 'abort', target: sig }) } catch (error) { /* 继续通知其余监听者 */ }
        }
        if (typeof sig.onabort === 'function') {
          try { sig.onabort.call(sig, { type: 'abort', target: sig }) } catch (error) { /* noop */ }
        }
        return true
      }
      return { signal: sig, abort: abort }
    }

    async function pickProvider() {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return { ok: false, error: 'Host subagents 服务不可用' }
      let names = []
      try { names = arr(subagents.list()).map(text) } catch (error) { names = [] }
      if (names.length === 0) return { ok: false, error: '当前部署没有注册任何子代理 provider' }
      const provider = names.indexOf('spawn') >= 0 ? 'spawn' : (names.indexOf('fork') >= 0 ? 'fork' : names[0])
      return { ok: true, provider: provider, names: names }
    }

    function releaseActive(childId) {
      if (!state.activeChildId) return
      if (childId && state.activeChildId !== childId) return
      state.activeKey = ''
      state.activeChildId = ''
      state.activeSince = 0
      stopUploadWatch()
    }

    function startUploadWatch() {
      stopUploadWatch()
      const timer = ctx.get('timer')
      if (timer === undefined || typeof timer.interval !== 'function') return
      state.uploadTimer = timer.interval(function () { runUploadWatch() }, 30000)
    }

    function stopUploadWatch() {
      if (state.uploadTimer) {
        try { state.uploadTimer() } catch (error) { /* 已清理 */ }
        state.uploadTimer = null
      }
    }

    async function runUploadWatch() {
      const keys = Object.keys(state.audits)
      for (let i = 0; i < keys.length; i += 1) {
        const rec = state.audits[keys[i]]
        if (!rec || rec.uploadedAt || rec.uploading) continue
        if (rec.key !== state.activeKey && rec.ended !== true) continue
        await maybeAutoUpload(rec)
      }
      const anyPending = Object.keys(state.audits).some(function (k) {
        const r = state.audits[k]
        return r && !r.uploadedAt && r.uploadError === '' && (r.uploading === true || r.key === state.activeKey)
      })
      if (!anyPending) stopUploadWatch()
    }

    async function maybeAutoUpload(rec) {
      if (!rec || rec.uploading || rec.uploadedAt) return { ok: false, error: '无需上传' }
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const oss = normalizeOss(manifest.oss)
      if (!oss.enabled || !oss.bucket || !oss.autoUpload) return { ok: false, error: '自动上云未启用' }
      if (!rec.casePath) return { ok: false, error: '尚未定位案例目录' }
      rec.uploading = true
      try {
        const platform = await detectPlatform()
        const ossutilPath = await resolveOssutil(oss, platform)
        if (!ossutilPath) throw new Error('未找到 ossutil')
        const target = await resolvePath(rec.casePath)
        const item = await inspectCase(target)
        if (!item) throw new Error('案例目录不可读')
        if (!item.htmlFile && !item.resultFile) throw new Error('案例还没有交付件')
        const out = await uploadArtifacts(item, rec.key, oss, ossutilPath)
        rec.uploading = false
        if (out.ok) {
          rec.uploadedAt = new Date().toISOString()
          rec.uploadError = ''
          rec.ossPrefix = out.prefix
        } else {
          rec.uploadError = text(out.error).slice(0, 300) || '上传失败'
        }
        return out
      } catch (error) {
        rec.uploading = false
        rec.uploadError = failureMessage(error).slice(0, 300)
        return { ok: false, error: rec.uploadError }
      }
    }

    async function uploadArtifacts(item, projectId, oss, ossutilPath) {
      const files = []
      if (item.htmlFile) files.push({ kind: 'html', name: item.htmlFile })
      if (item.resultFile) files.push({ kind: 'json', name: item.resultFile })
      if (files.length === 0) return { ok: false, error: '没有可回传的交付件' }
      // 对象 key 只用报告流水号：它本身唯一，是唯一的查找键。
      // 不再按年/月分段 —— 那两个数字取自审核结果里的业务时间戳
      // （auditTask.auditTime，取不到时回退 fileTrace.generatedAt），
      // 两者可以相隔数月，读不到 JSON 时更会静默回退成"当前系统时间"，
      // 同一条流水号会被拆进不同月份目录。读端 seqNoFromKey 会扫描 key
      // 中的流水号模式，因此旧布局的对象仍能识别，无需迁移。
      const prefix = oss.prefix + '/' + (projectId || item.name)
      const results = []
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const local = item.path.replace(/\/+$/, '') + '/' + file.name
        const key = prefix + '/' + file.name
        const argv = [ossutilPath, 'cp', '-f', local, 'oss://' + oss.bucket + '/' + key]
        if (oss.endpoint) argv.push('--endpoint', oss.endpoint)
        for (let j = 0; j < oss.extraArgs.length; j += 1) argv.push(oss.extraArgs[j])
        const run = await runShell(argv.map(quoteArg).join(' '), undefined, 180000, false)
        results.push({
          kind: file.kind, name: file.name, key: key,
          ok: run.ok === true,
          publicUrl: joinUrl(oss.publicBaseUrl, key),
          error: run.ok === true ? '' : (text(run.stderr) || text(run.error) || '上传失败').slice(0, 400),
        })
      }
      const allOk = results.every(function (r) { return r.ok })
      return {
        ok: allOk, bucket: oss.bucket, prefix: prefix, results: results,
        error: allOk ? '' : (results.filter(function (r) { return !r.ok }).map(function (r) { return r.name + '：' + r.error }).join('；')).slice(0, 500),
      }
    }

    // SubagentStopReason 只有四个取值：completed / aborted / error / max-tokens
    // （dsh-subagent types.d.ts:239，completed = "The child finished its turn normally"）。
    // 旧代码只看 rec.resultFile 是否为空就判"已中断" —— 但 subagent/end 触发时
    // 交付件通常还没被文件系统扫描发现，于是每一次**正常完成**都被渲染成
    // 「已中断」，还把原始枚举值当成人话显示成「结束原因：completed」。
    function describeEndReason(reason) {
      if (reason === 'completed') return '子会话已正常结束'
      if (reason === 'aborted') return '子会话被取消（不是从工作台点的停止）'
      if (reason === 'error') return '子会话异常结束（模型或传输故障）'
      if (reason === 'max-tokens') return '子会话达到 token 上限，未跑完'
      return '结束原因：' + reason
    }

    const agentsSvc = ctx.get('agents')
    if (agentsSvc !== undefined) {
      ctx.on('agent/status', (payload) => {
        const target = payload && payload.agent ? payload.agent : null
        if (!target) return
        const id = text(target.id)
        const running = payload.status === 'running'
        Object.keys(state.audits).forEach((key) => {
          const rec = state.audits[key]
          if (rec && rec.childId === id && rec.ended !== true) {
            state.audits[key] = Object.assign({}, rec, { status: running ? 'running' : 'idle' })
          }
        })
      })
      ctx.on('subagent/end', (info) => {
        const id = text(info && (info.childId || info.id))
        if (!id) return
        const reason = text(info && info.stopReason) || 'error'
        Object.keys(state.audits).forEach((key) => {
          const rec = state.audits[key]
          if (rec && rec.childId === id) {
            state.audits[key] = Object.assign({}, rec, {
              ended: true,
              endReason: reason,
              // 正常跑完 → idle（等文件系统扫描把交付件找出来再升级成 done）；
              // 只有 error / max-tokens 才是真的失败。交付件是否存在由
              // audit-status 的目录扫描决定，不在这里猜。
              status: rec.stopped === true ? 'stopped'
                : (reason === 'completed' ? 'idle' : 'failed'),
              stopReason: rec.stopped === true ? '已被用户手动停止' : describeEndReason(reason),
            })
          }
        })
        if (state.activeChildId === id) {
          state.activeKey = ''
          state.activeChildId = ''
          state.activeSince = 0
        }
        delete state.runs[id]
        startUploadWatch()
        runUploadWatch()
        persistAudits().catch(function () {})
      })
    }

    function joinUrl(base, key) {
      const b = text(base).replace(/\/+$/, '')
      if (!b) return ''
      return b + '/' + key.split('/').map(function (seg) { return encodeURIComponent(seg) }).join('/')
    }

    async function startChild(label, prompt) {
      const agentSvc = ctx.get('agents')
      const subagents = ctx.get('subagents')
      if (agentSvc === undefined) return { ok: false, error: 'Host agents 服务不可用' }
      if (subagents === undefined) return { ok: false, error: 'Host subagents 服务不可用' }
      if (!state.workspaceChosen) return { ok: false, error: '尚未选定工作空间：请先在第 ① 步选定工作空间。' }
      const parentId = state.parentSessionId
      if (!parentId) return { ok: false, error: '尚未绑定子会话父级：请在对话里打开一次工作台运行卡片（会自动登记当前会话），再回来操作。' }
      const parent = agentSvc.get(parentId)
      if (!parent) return { ok: false, error: '父会话的 Agent 不在运行中（id ' + parentId + '），无法创建子会话。' }
      const picked = await pickProvider()
      if (!picked.ok) return { ok: false, error: picked.error }
      const ctl = makeAbortableSignal()
      let started
      try {
        started = await subagents.start(picked.provider, {
          label: label,
          prompt: [{ type: 'text', text: prompt }],
          parent: parent,
          signal: ctl.signal,
        })
      } catch (error) {
        return { ok: false, error: '创建子会话失败：' + failureMessage(error) }
      }
      return { ok: true, childId: text(started && started.id), provider: picked.provider, run: started, abort: ctl.abort }
    }

    async function readOssCred() {
      const f = getFs()
      const path = await ossConfigPath()
      const res = { path: path, exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' }
      if (f === undefined) return res
      try {
        const target = await resolvePath(path)
        const info = await f.stat(target)
        if (!info || info.type !== 'file') return res
        const cfg = parseOssConfig(await f.readText(target))
        res.exists = true
        res.endpoint = text(cfg.endpoint)
        res.accessKeyIdMasked = maskKey(cfg.accesskeyid)
        res.hasSecret = !!text(cfg.accesskeysecret)
        res.hasSts = !!text(cfg.ststoken)
        res.language = text(cfg.language)
      } catch (error) { /* 不存在或不可读 */ }
      return res
    }

    async function ossConfigPath() {
      const home = await homeDir()
      return home ? (home.replace(/[\\/]+$/, '') + '/.ossutilconfig') : '~/.ossutilconfig'
    }

    function parseOssConfig(txt) {
      const out = {}
      text(txt).split(/\r?\n/).forEach(function (line) {
        const s = line.trim()
        if (!s || s.charAt(0) === '#' || s.charAt(0) === '[') return
        const i = s.indexOf('=')
        if (i <= 0) return
        out[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim()
      })
      return out
    }

    function maskKey(k) {
      const s = text(k)
      if (!s) return ''
      if (s.length <= 8) return '****'
      return s.slice(0, 4) + '****' + s.slice(-4)
    }

    function buildOssConfig(input) {
      const L = ['[Credentials]']
      L.push('language=' + (text(input.language) || 'CH'))
      if (text(input.endpoint)) L.push('endpoint=' + text(input.endpoint))
      L.push('accessKeyID=' + text(input.accessKeyId))
      L.push('accessKeySecret=' + text(input.accessKeySecret))
      if (text(input.stsToken)) L.push('stsToken=' + text(input.stsToken))
      return L.join('\n') + '\n'
    }

    async function writeOssCred(input) {
      const f = getFs()
      if (f === undefined) return { ok: false, error: 'Host 文件服务不可用' }
      const path = await ossConfigPath()
      const content = buildOssConfig(input)
      let outcome
      try {
        const target = await resolvePath(path)
        outcome = await f.writeText(target, content)
      } catch (error) {
        return { ok: false, error: '写入 ' + path + ' 失败：' + failureMessage(error) }
      }
      const chmod = await runShell('chmod 600 ' + quoteArg(path), undefined, 15000, false)
      return {
        ok: true, path: path,
        operation: outcome && outcome.operation ? text(outcome.operation) : '',
        chmodOk: chmod.ok === true,
        chmodError: chmod.ok === true ? '' : (text(chmod.stderr) || text(chmod.error) || '权限设置失败').slice(0, 200),
      }
    }

    // ── 案例根目录（工作空间）解析 ─────────────────────────────────────────
    // 三级规则，每级都可解释：
    //   1. 你上次在工作台里显式选过的目录（持久化，插件更新不丢）
    //   2. 远程 manifest 指定的工作空间（workspace.preferPath / preferTitle）
    //   3. 都没有 → 不自动采用，仍要求显式选
    // 绝不采用「父会话所属的工作空间」：本机该会话属于 crwu-ai 工作空间，
    // 也就是源码仓库本身，采用它等于把审核产物写进代码仓库。
    function trimSlash(p) { return text(p).replace(/\/+$/, '') }

    async function workbenchConfigPath() {
      const home = await homeDir()
      return home ? (trimSlash(home) + '/.dsh/crwu-workbench.json') : '~/.dsh/crwu-workbench.json'
    }

    async function readWorkbenchConfig() {
      const f = getFs()
      if (f === undefined) return {}
      try {
        const target = await resolvePath(await workbenchConfigPath())
        const info = await f.stat(target)
        if (!info || info.type !== 'file') return {}
        const doc = parseJsonLoose(await f.readText(target))
        return doc && typeof doc === 'object' ? doc : {}
      } catch (error) { return {} }
    }

    async function writeWorkbenchConfig(patch) {
      const f = getFs()
      if (f === undefined) return false
      const next = Object.assign({}, await readWorkbenchConfig(), patch)
      try {
        const target = await resolvePath(await workbenchConfigPath())
        await f.writeText(target, JSON.stringify(next, null, 2) + '\n')
        return true
      } catch (error) { return false }
    }

    // ── 审计记录落盘 ──────────────────────────────────────────────────────
    // 只写可序列化字段；uploading / runs 这类活状态一律不写。
    function persistableAudits() {
      const out = {}
      Object.keys(state.audits).forEach(function (k) {
        const r = state.audits[k]
        if (!r) return
        out[k] = {
          key: text(r.key) || k, childId: text(r.childId), seqNo: text(r.seqNo), project: text(r.project),
          objectId: text(r.objectId), startedAt: text(r.startedAt), parentSessionId: text(r.parentSessionId),
          mode: text(r.mode) || 'one-shot', casePath: text(r.casePath), attempt: num(r.attempt) || 1,
          ended: r.ended === true, endReason: text(r.endReason), stopped: r.stopped === true,
          status: text(r.status), stopReason: text(r.stopReason),
          resultFile: text(r.resultFile), htmlFile: text(r.htmlFile), caseName: text(r.caseName),
          uploadedAt: text(r.uploadedAt), uploadError: text(r.uploadError), ossPrefix: text(r.ossPrefix),
          adopted: r.adopted === true,
        }
      })
      return out
    }

    async function persistAudits() {
      return await writeWorkbenchConfig({
        audits: persistableAudits(),
        activeKey: state.activeKey,
        activeChildId: state.activeChildId,
      })
    }

    // 幂等：只读一次，之后由本进程负责写回。
    async function ensureRegistry() {
      if (state.registryLoaded) return
      state.registryLoaded = true
      const cfg = await readWorkbenchConfig()
      const saved = cfg && cfg.audits && typeof cfg.audits === 'object' ? cfg.audits : {}
      Object.keys(saved).forEach(function (k) {
        const r = saved[k]
        if (!r || typeof r !== 'object') return
        if (state.audits[k]) return
        state.audits[k] = {
          key: text(r.key) || k, childId: text(r.childId), seqNo: text(r.seqNo), project: text(r.project),
          objectId: text(r.objectId), startedAt: text(r.startedAt), parentSessionId: text(r.parentSessionId),
          mode: text(r.mode) || 'one-shot', casePath: text(r.casePath), attempt: num(r.attempt) || 1,
          ended: r.ended === true, endReason: text(r.endReason), stopped: r.stopped === true,
          status: text(r.status) || 'idle', stopReason: text(r.stopReason),
          resultFile: text(r.resultFile), htmlFile: text(r.htmlFile), caseName: text(r.caseName),
          uploadedAt: text(r.uploadedAt), uploadError: text(r.uploadError), ossPrefix: text(r.ossPrefix),
          uploading: false, adopted: r.adopted === true,
        }
      })
      // 占用锁一起恢复，否则重装后同一条报告能被起第二条子会话，
      // 两条会往同一个案例目录对写。
      if (!state.activeChildId) {
        state.activeKey = text(cfg.activeKey)
        state.activeChildId = text(cfg.activeChildId)
      }
    }

    async function dirExists(p) {
      const f = getFs()
      if (f === undefined || !text(p)) return false
      try {
        const info = await f.stat(await resolvePath(p))
        return !!(info && info.type === 'directory')
      } catch (error) { return false }
    }

    // 只读地报告「当前会话属于哪个 DSH 工作空间」，用于界面提示，不参与选根。
    function sessionWorkspaceInfo() {
      const sessions = ctx.get('sessions')
      const registry = ctx.get('workspaceRegistry')
      const out = { parentSessionId: state.parentSessionId, sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' }
      if (!state.parentSessionId) return out
      if (sessions !== undefined && typeof sessions.get === 'function') {
        try {
          const s = sessions.get(state.parentSessionId)
          out.sessionCwd = s && s.header && s.header.cwd ? text(s.header.cwd) : ''
        } catch (error) { out.sessionCwd = '' }
      }
      if (!out.sessionCwd) return out
      let best = null
      try {
        const list = arr(registry === undefined ? [] : registry.list())
        for (let i = 0; i < list.length; i += 1) {
          const p = trimSlash(list[i] && list[i].path)
          if (!p) continue
          if (out.sessionCwd === p || out.sessionCwd.indexOf(p + '/') === 0) {
            if (!best || p.length > best.path.length) {
              best = { id: text(list[i].id), path: p, title: text(list[i].title) || p }
            }
          }
        }
      } catch (error) { best = null }
      if (best) {
        out.workspaceId = best.id
        out.workspacePath = best.path
        out.workspaceTitle = best.title
      }
      return out
    }

    async function registryList() {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return []
      try { return arr(registry.list()) } catch (error) { return [] }
    }

    // ── 会话层级 ──────────────────────────────────────────────────────────
    // 审核只允许挂在**顶层会话**下（子代理深度 1）。把子代理登记成父级会派生出
    // depth 2 的审核，于是"只监控一层子会话"就失效了 —— 父级自己还是个随时会结束
    // 的子代理，一旦它结束，界面就再也定位不到真正在跑的那条，也就是"会话跟丢"。
    // 判据只有子代理才有的两个字段：origin === 'subagent' 与 delegationDepth
    // （dsh-session types.d.ts:81/87，顶层会话两者都没有）。
    function sessionDelegation(id) {
      const out = { found: false, subagent: false, depth: 0, parentSession: '' }
      const sid = text(id)
      if (!sid) return out
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.get !== 'function') return out
      try {
        const s = sessions.get(sid)
        const h = s && s.header ? s.header : null
        if (!h) return out
        out.found = true
        out.subagent = text(h.origin) === 'subagent'
        out.depth = num(h.delegationDepth)
        out.parentSession = text(h.parentSession)
      } catch (error) { /* 拿不到就按"未知"处理，不阻断用户 */ }
      return out
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n }

    // 子会话 label 里带一个启动时间戳：同一条报告被重启多次时，清单里会出现多个
    // 同名子会话，光看流水号分不清哪个是这一轮，也没法判断"这条任务已经有了"。
    // 时间戳只作后缀，流水号始终是第一个 token。
    function auditLabel(seqNo, when) {
      const d = when instanceof Date ? when : new Date()
      const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
      return '审核 ' + text(seqNo) + ' · ' + clock
    }

    function seqNoFromLabel(label) {
      const m = /^审核\s+(\S+)/.exec(text(label))
      return m ? m[1] : ''
    }

    async function resolveAuditWorkspace() {
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const prefer = manifest.workspace || BUILTIN_MANIFEST.workspace
      const list = await registryList()

      const savedPath = trimSlash((await readWorkbenchConfig()).workspacePath)
      if (savedPath && await dirExists(savedPath)) {
        let id = ''
        try {
          const registry = ctx.get('workspaceRegistry')
          if (registry !== undefined && typeof registry.resolveByPath === 'function') {
            const w = await registry.resolveByPath(savedPath)
            id = text(w && w.id)
          }
        } catch (error) { id = '' }
        const hit = list.filter(function (w) { return trimSlash(w && w.path) === savedPath })[0]
        return {
          ok: true, path: savedPath, source: 'saved', id: id || text(hit && hit.id),
          title: text(hit && hit.title) || savedPath,
        }
      }

      const wantPath = trimSlash(prefer.preferPath)
      const wantTitle = text(prefer.preferTitle)
      let hit = wantPath ? list.filter(function (w) { return trimSlash(w && w.path) === wantPath })[0] : null
      if (!hit && wantTitle) hit = list.filter(function (w) { return text(w && w.title) === wantTitle })[0]
      if (!hit && wantTitle) hit = list.filter(function (w) { return text(w && w.path).indexOf(wantTitle) >= 0 })[0]
      if (hit && await dirExists(trimSlash(hit.path))) {
        return { ok: true, path: trimSlash(hit.path), source: 'manifest-workspace', id: text(hit.id), title: text(hit.title) || wantTitle }
      }

      return { ok: false, path: '', source: '', id: '', title: '' }
    }

    // 幂等：已经选定（显式或已采用）就不动，避免每次自检把用户的选择覆盖掉。
    async function ensureWorkspace() {
      if (state.workspaceChosen && state.workspacePath) return
      const r = await resolveAuditWorkspace()
      if (!r.ok) return
      state.workspacePath = r.path
      state.workspaceTitle = r.title
      state.workspaceId = r.id
      state.workspaceSource = r.source
      state.root = r.path
      state.workspaceChosen = true
    }

    function workspaceView() {
      return {
        chosen: state.workspaceChosen,
        path: state.workspacePath,
        title: state.workspaceTitle || state.workspacePath,
        id: state.workspaceId,
        source: state.workspaceSource,
      }
    }

    harness.handle('workbench:boot', async () => {
      await ensureRegistry()
      await ensureWorkspace()
      const root = await defaultRoot()
      const platform = await detectPlatform()
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      let version = ''
      try {
        const run = await runShell('crwu version', undefined, 20000, false)
        version = text(run.stdout).trim().split('\n')[0]
      } catch (error) { version = '' }
      return {
        ok: true,
        root: root,
        sessionRoot: await sessionRoot(),
        preferredRoot: DEFAULT_CASE_ROOT,
        manifestSource: state.manifestSource || DEFAULT_MANIFEST_SOURCE,
        installDocUrl: text(manifest.installDocUrl) || DEFAULT_INSTALL_DOC,
        formName: state.formName,
        parentSessionId: state.parentSessionId,
        platform: platform,
        workspace: workspaceView(),
        sessionWorkspace: sessionWorkspaceInfo(),
        crwuVersion: version,
        active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
      }
    })

    harness.handle('workbench:workspace', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const path = trimSlash(a.path)
      if (path) {
        state.workspacePath = path
        state.workspaceTitle = text(a.title) || path
        state.workspaceId = text(a.id)
        state.workspaceSource = 'manual'
        state.root = path
        state.workspaceChosen = true
        state.persistOk = await writeWorkbenchConfig({ workspacePath: path })
      }
      return { ok: true, workspace: workspaceView(), sessionWorkspace: sessionWorkspaceInfo() }
    })

    // 「恢复自动」：丢掉持久化的手动选择，回到三级规则。
    harness.handle('workbench:workspace-auto', async () => {
      state.persistOk = await writeWorkbenchConfig({ workspacePath: '' })
      state.workspaceChosen = false
      state.workspacePath = ''
      state.workspaceTitle = ''
      state.workspaceId = ''
      state.workspaceSource = ''
      await ensureWorkspace()
      return { ok: true, workspace: workspaceView(), sessionWorkspace: sessionWorkspaceInfo() }
    })

    harness.handle('workbench:trust', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      state.trustH3yun = a.h3yun === true
      return { ok: true, trust: { h3yun: state.trustH3yun } }
    })

    harness.handle('workbench:bind-session', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const id = text(a.sessionId)
      if (!id) return { ok: false, error: '缺少 sessionId' }
      // 审核只允许挂在顶层会话下。把子代理登记成父级，派生的审核就是 depth 2，
      // "只监控一层子会话"随即失效（父级自身还会结束），于是状态跟丢。
      // 这里直接拒绝，并保留原来那个合法的顶层父级。
      const info = sessionDelegation(id)
      if (info.found && info.subagent) {
        return {
          ok: false, subagent: true, depth: info.depth, parentSessionId: state.parentSessionId,
          error: '这个会话本身是子代理（delegationDepth ' + (info.depth || 1) + '），不能当审核父级：审核只允许挂在顶层会话下，嵌套会引入一堆状态跟丢的问题。请在顶层会话里打开工作台。',
          workspace: workspaceView(), sessionWorkspace: sessionWorkspaceInfo(),
        }
      }
      state.parentSessionId = id
      await ensureWorkspace()
      return {
        ok: true, parentSessionId: id, subagent: false, depth: 0,
        workspace: workspaceView(), sessionWorkspace: sessionWorkspaceInfo(),
      }
    })

    harness.handle('workbench:clipboard', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const content = text(a.text)
      if (!content) return { ok: false, error: '没有内容' }
      const platform = await detectPlatform()
      let cmd = ''
      if (platform.indexOf('darwin') === 0) cmd = 'pbcopy'
      else if (platform.indexOf('win32') === 0) cmd = 'clip'
      else cmd = 'xclip -selection clipboard 2>/dev/null || xsel -b'
      const run = await runShell(cmd, undefined, 20000, true, 65536, content)
      return {
        ok: run.ok === true,
        error: run.ok === true ? '' : (text(run.stderr) || text(run.error) || '剪贴板命令不可用').slice(0, 200),
      }
    })

    harness.handle('workbench:install-prompt', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const url = text(manifest.installDocUrl) || DEFAULT_INSTALL_DOC
      const ws = text(a.workspace) || state.workspacePath || state.root
      return { ok: true, url: url, prompt: buildInstallPromptText(url, ws) }
    })

    harness.handle('workbench:oss-cred', async () => {
      return { ok: true, cred: await readOssCred() }
    })

    harness.handle('workbench:oss-cred-save', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const accessKeyId = text(a.accessKeyId).trim()
      const accessKeySecret = text(a.accessKeySecret).trim()
      if (!accessKeyId || !accessKeySecret) return { ok: false, error: 'AccessKey ID 与 AccessKey Secret 都不能为空。' }
      if (/[\r\n]/.test(accessKeyId) || /[\r\n]/.test(accessKeySecret)) return { ok: false, error: '凭据不能包含换行。' }
      const written = await writeOssCred({
        accessKeyId: accessKeyId,
        accessKeySecret: accessKeySecret,
        stsToken: text(a.stsToken).trim(),
        endpoint: text(a.endpoint).trim(),
        language: 'CH',
      })
      if (!written.ok) return { ok: false, error: written.error }
      const platform = await detectPlatform()
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const oss = normalizeOss(manifest.oss)
      const probe = await probeOss(oss, true, platform)
      const cred = await readOssCred()
      return {
        ok: true, path: written.path, operation: written.operation,
        chmodOk: written.chmodOk, chmodError: written.chmodError,
        probe: probe, cred: cred,
      }
    })

    harness.handle('workbench:audit-start', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      await ensureRegistry()
      const key = text(a.key) || text(a.seqNo)
      if (!key) return { ok: false, error: '缺少任务标识' }
      if (state.startingKey) {
        return { ok: false, error: '正在创建审核子会话（' + state.startingKey + '），请勿重复提交。' }
      }
      state.startingKey = key
      try {
        const seqNo = text(a.seqNo)
        // 硬门禁：父级必须是顶层会话。登记时已经拦过一次，这里再拦一次是因为
        // state.parentSessionId 可能是**旧版本插件**落下来的子代理 id，或者绑定之后
        // 那个会话被降级成了子代理。嵌套审核必须彻底挡在门外。
        const parentInfo = sessionDelegation(state.parentSessionId)
        if (parentInfo.found && parentInfo.subagent) {
          return {
            ok: false,
            error: '当前登记的审核父级 ' + text(state.parentSessionId).slice(0, 8) + '… 本身是子代理（delegationDepth ' + (parentInfo.depth || 1) + '）。审核只允许挂在顶层会话下（只挂一层，方便盯状态）。请在顶层会话里打开工作台完成登记，再发起审核。',
          }
        }
        const subagents = ctx.get('subagents')
        const prev = state.audits[key]
        // 单条并发门禁：**别的**报告正在跑时拒绝；同一条报告则是"重启"（下面处理），
        // 否则「重启」这条路会被自己的锁挡死。
        if (state.activeChildId && state.activeKey !== key) {
          return { ok: false, error: '已有审核在进行中（' + (state.activeKey || state.activeChildId) + '）。同一时间只允许一条，等它结束或先点「停止」。' }
        }
        // 「这条任务已经有了」的处理：不另起一条，也不无视它 —— 把已经存在的子会话
        // 停掉，再用**重新审核**的提示词重启一个，并给新会话盖上启动时间戳。
        // 存在的子会话不能只查 state.audits：插件重装后记录可能已经没了，而清单里
        // 那个子会话还在跑（label 里带流水号），漏掉它就会让两条子会话交叉写同一个
        // 案例目录。所以两边都算。
        const stale = []
        if (prev && prev.childId && prev.ended !== true && prev.stopped !== true) stale.push(prev.childId)
        if (subagents !== undefined && state.parentSessionId) {
          try {
            const children = await subagents.listChildren(state.parentSessionId)
            for (let i = 0; i < children.length; i += 1) {
              const c = children[i]
              if (!c || c.kind !== 'child') continue
              const cid = text(c.id)
              if (!cid || stale.indexOf(cid) >= 0) continue
              if (seqNoFromLabel(c.label) !== seqNo) continue
              if (text(c.activity) !== 'running') continue
              stale.push(cid)
            }
          } catch (error) { /* 清单查不到就只按记录走 */ }
        }
        // 有前一轮（记录里的或清单里的）→ 走重审提示词：从零重跑、不读旧产物。
        // 界面知道「云端已有审核意见」而 Host 不知道，所以它也会显式传 retry:true。
        const isRetry = stale.length > 0 || !!prev || a.retry === true
        let replaced = ''
        for (let i = 0; i < stale.length; i += 1) {
          const stopped = await stopChild(stale[i], '这条报告已有审核子会话，先停掉它再重启一条')
          if (!stopped.aborted && stopped.errors.length > 0) {
            return { ok: false, error: '已有的审核子会话（' + stale[i].slice(0, 8) + '）停不掉，为避免两条子会话交叉写同一个案例目录，已中止本次重启：' + stopped.errors.join('；') }
          }
          if (i === 0) replaced = stale[i]
        }
        const stamp = new Date()
        const started = await startChild(auditLabel(seqNo, stamp), auditPrompt({
          objectId: text(a.objectId), seqNo: seqNo, project: text(a.project),
          workspace: state.workspacePath || state.root,
          oss: normalizeOss((state.manifest || normalizeManifest(BUILTIN_MANIFEST)).oss),
          isRetry: isRetry,
        }))
        if (!started.ok) return { ok: false, error: started.error }
        // 留住「可中止的信号 + run 句柄」：一次性运行没有别的停止入口
        // （subagents.interrupt 对 one-shot 是记录在案的 no-op）。
        // 停止时必须先 abort 再 dispose，见 workbench:audit-stop。
        if (started.run || started.abort) {
          state.runs[started.childId] = { run: started.run, abort: started.abort }
        }
        state.audits[key] = {
          key: key, childId: started.childId, status: 'running', ended: false, stopReason: '',
          parentSessionId: state.parentSessionId, mode: 'one-shot',
          seqNo: seqNo, project: text(a.project), objectId: text(a.objectId),
          startedAt: stamp.toISOString(), casePath: '', resultFile: '', htmlFile: '', caseName: '',
          uploading: false, uploadedAt: '', uploadError: '', ossPrefix: '',
          attempt: (prev && prev.attempt ? prev.attempt : 0) + 1, replacedChildId: replaced,
        }
        state.activeKey = key
        state.activeChildId = started.childId
        state.activeSince = stamp.getTime()
        startUploadWatch()
        await persistAudits()
        return {
          ok: true, childId: started.childId, provider: started.provider, parentSessionId: state.parentSessionId,
          mode: 'one-shot', isRetry: isRetry, replaced: replaced, replacedCount: stale.length,
          startedAt: stamp.toISOString(), attempt: state.audits[key].attempt,
        }
      } finally {
        if (state.startingKey === key) state.startingKey = ''
      }
    })

    harness.handle('workbench:audit-release', async () => {
      const prev = state.activeKey || state.activeChildId
      releaseActive()
      return { ok: true, released: prev }
    })

    // ── 停止一条审核子会话 ────────────────────────────────────────────────
    // 三条路都试过之后的理解：
    // 1) subagents.interrupt —— 契约明写对 one-shot 是 no-op（types/index.d.ts:153），
    //    工作台用 subagents.start 起的就是 one-shot，所以它没用。只作兜底。
    // 2) run.dispose() 单独调 —— 更糟：它先 removeEventListener('abort', onAbort)
    //    再 await result（in-process-driver:222），等于把唯一取消路径摘掉后干等，
    //    审核停不下来、调用还会挂住。
    // 3) **唯一真取消**：abort 我们传给 subagents.start 的那个 signal。
    //    驱动里的 onAbort 会 child.cancel({kind:'parent'})（driver:199）。
    // 所以顺序必须是 abort() → 再 dispose()（此时 result 已经结算，dispose 才不挂）。
    // 抽成函数是因为「重新审核」也要用它：同一个报告重跑时，上一轮的子会话
    // 只要还没结束就必须先停掉，否则它的 childId 会被新记录覆盖掉，
    // 界面上再也点不到它，那个会话就成了停不掉的孤儿。
    async function stopChild(childId, reasonText) {
      const out = { childId: childId, aborted: false, disposed: false, interrupted: false, agentCancelled: false, errors: [] }
      const entry = state.runs[childId]
      if (entry && typeof entry.abort === 'function') {
        try {
          out.aborted = entry.abort(new Error(reasonText || '用户在中瑞世联工作台停止了这条审核')) === true
        } catch (error) { out.errors.push('abort：' + failureMessage(error)) }
      } else {
        // 句柄没了的退路（插件重装后就是这样：子会话还在跑，但 state.runs 已清空）。
        // 直接对子 Agent 调 cancel —— 这正是驱动里 onAbort 做的事
        // （in-process-driver:200 `child.cancel({ kind: "parent" })`），
        // 而 agents.get(childId) 拿到的就是那个还活着的子 Agent。
        const agents = ctx.get('agents')
        const child = agents !== undefined && typeof agents.get === 'function' ? agents.get(childId) : undefined
        if (child && typeof child.cancel === 'function') {
          try {
            child.cancel({ kind: 'parent' })
            out.agentCancelled = true
            out.aborted = true
          } catch (error) { out.errors.push('cancel：' + failureMessage(error)) }
        } else {
          out.errors.push('该子会话已不在运行中的 Agent 注册表里（可能已结束），没有可用的取消入口。')
        }
      }
      if (entry && entry.run && typeof entry.run.dispose === 'function') {
        const timer = ctx.get('timer')
        let settled = false
        const pending = entry.run.dispose().then(
          function () { settled = true },
          function (error) { out.errors.push('dispose：' + failureMessage(error)) },
        )
        try {
          if (timer !== undefined && typeof timer.timeout === 'function') {
            await Promise.race([pending, timer.timeout(8000)])
          } else {
            await pending
          }
        } catch (error) {
          out.errors.push('dispose 等待超时；取消信号已发出，句柄会自行释放。')
        }
        out.disposed = settled
      }
      delete state.runs[childId]
      const subagents = ctx.get('subagents')
      if (subagents !== undefined && typeof subagents.interrupt === 'function' && state.parentSessionId) {
        try {
          subagents.interrupt(childId, { kind: 'user', parentSessionId: state.parentSessionId })
          out.interrupted = true
        } catch (error) { out.errors.push('interrupt：' + failureMessage(error)) }
      }
      return out
    }

    harness.handle('workbench:audit-stop', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      await ensureRegistry()
      const childId = text(a.childId) || state.activeChildId
      if (!childId) return { ok: false, error: '当前没有正在运行的审核子会话。' }
      const out = await stopChild(childId, '用户在中瑞世联工作台手动停止了这条审核')
      out.ok = true
      const key = Object.keys(state.audits).filter(function (k) {
        return state.audits[k] && state.audits[k].childId === childId
      })[0]
      if (key) {
        state.audits[key] = Object.assign({}, state.audits[key], {
          stopped: true, ended: true, status: 'stopped', stopReason: '已被用户手动停止',
        })
      }
      releaseActive(childId)
      stopUploadWatch()
      await persistAudits()
      out.key = key || ''
      return out
    })

    harness.handle('workbench:audit-status', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      await ensureRegistry()
      const subagents = ctx.get('subagents')
      const agents = ctx.get('agents')
      const keys = arr(a.keys).map(text)
      const activity = {}
      const labels = {}
      const parentOf = {}
      const boundParentId = text(a.parentSessionId) || state.parentSessionId
      // 一次要查**多个**父会话：每条审核记录都记着自己启动时的那个父会话，而
      // state.parentSessionId 只是「用户最后看过哪个会话」，会随浏览漂移。
      // 只查全局那一个的话，父会话一变，所有记录的子会话都查不到 —— 界面集体
      // 退化成"未出结果"，也就是"会话跟丢了"。
      // 审核还可能挂在子代理之下：在审核子会话里再开一次工作台，派生的审核就是
      // depth 2，那个父会话只出现在记录里，永远不会是全局的那一个。
      const queryParents = {}
      if (boundParentId) queryParents[boundParentId] = true
      Object.keys(state.audits).forEach(function (k) {
        const p = text(state.audits[k] && state.audits[k].parentSessionId)
        if (p) queryParents[p] = true
      })
      const parentIds = Object.keys(queryParents)
      if (subagents !== undefined) {
        for (let i = 0; i < parentIds.length; i += 1) {
          try {
            const children = await subagents.listChildren(parentIds[i])
            for (let j = 0; j < children.length; j += 1) {
              const c = children[j]
              if (c && c.kind === 'child') {
                const cid = text(c.id)
                activity[cid] = text(c.activity)
                labels[cid] = text(c.label)
                if (!parentOf[cid]) parentOf[cid] = parentIds[i]
              }
            }
          } catch (error) { /* 这个父会话查不到就跳过，不拖累其它父会话 */ }
        }
      }
      // 真正的存活判据是**子 Agent 自己的生命周期状态**，与父会话无关。
      // AgentStatus 只有 idle / running，且 running 覆盖整个活动回合
      // （dsh-agent runtime-types.d.ts:84-89）。listChildren 是会话存储驱动的，
      // 跑完的一次性子会话**依然在列**，所以它只用来做"兜底认领"，不判断存活。
      function agentStatusOf(id) {
        if (agents === undefined || typeof agents.get !== 'function' || !id) return ''
        try {
          const agent = agents.get(id)
          return agent && typeof agent.status === 'string' ? text(agent.status) : ''
        } catch (error) { return '' }
      }
      // ── 兜底认领 ──────────────────────────────────────────────────────────
      // 面板应该投影「父会话当前真实的子代理清单」，而不只是「本进程记过的东西」。
      // 还在跑、但本进程没有记录的审核子会话（插件重装；或者当时还没落盘）
      // 按它的 label「审核 <SeqNo>」认回对应的报告行；否则它在面板上完全不显示，
      // 也就没有任何入口能停掉它 —— 正是「子任务还在跑但看不到状态」那个现象。
      let adoptedAny = false
      Object.keys(activity).forEach(function (cid) {
        if (!cid) return
        const claimed = Object.keys(state.audits).some(function (k) {
          return state.audits[k] && state.audits[k].childId === cid
        })
        if (claimed) return
        // 只认领**真的还在跑**的子会话。listChildren 是会话存储驱动的（扫的是
        // 会话头的 parentSession/origin，不是活 Agent 注册表），跑完的一次性子会话
        // **依然在列**。把不在跑的也当"运行中"认领，等于凭空造出一条「审核进行中」：
        // 单条门禁被锁死，界面还给一个早已结束的会话装出「停止」按钮。
        if (agentStatusOf(cid) !== 'running') return
        const seq = seqNoFromLabel(labels[cid])
        if (!seq || state.audits[seq]) return
        state.audits[seq] = {
          key: seq, childId: cid, seqNo: seq, project: '', objectId: '',
          parentSessionId: parentOf[cid] || boundParentId, mode: 'one-shot', startedAt: '', casePath: '',
          ended: false, endReason: '', stopped: false, status: 'running', stopReason: '',
          resultFile: '', htmlFile: '', caseName: '', uploading: false,
          uploadedAt: '', uploadError: '', ossPrefix: '', attempt: 1, adopted: true,
        }
        // 一并把单一审核的占用锁恢复，避免它正跑着时又被起第二条。
        if (!state.activeChildId) {
          state.activeKey = seq
          state.activeChildId = cid
          state.activeSince = Date.now()
        }
        adoptedAny = true
      })
      const wanted = keys.length > 0 ? keys : Object.keys(state.audits)
      const out = []
      let changed = adoptedAny
      for (let i = 0; i < wanted.length; i += 1) {
        const key = wanted[i]
        const rec = state.audits[key]
        if (!rec) continue
        const act = rec.childId ? text(activity[rec.childId]) : ''
        // 在不在子代理清单里只作为补充信息：跑完的一次性子会话会一直留在清单里
        // （listChildren 扫的是会话存储，不是活 Agent 注册表），所以"在列"不等于"活着"。
        const listed = rec.childId ? Object.prototype.hasOwnProperty.call(activity, rec.childId) : false
        // 刚起的子会话可能还没被驱动翻成 running，给 20 秒宽限，
        // 否则「停止」会在头几秒里闪成「重新审核」。
        const bornAt = rec.startedAt ? Date.parse(rec.startedAt) : NaN
        const fresh = isFinite(bornAt) && (Date.now() - bornAt) < 20000
        // **存活 = 子 Agent 自己还在 running**。这个判据与父会话无关，所以父会话
        // 漂移、或者这条审核挂在别的子代理之下，都不会再跟丢。
        const agentRunning = agentStatusOf(rec.childId) === 'running'
        const childAlive = rec.ended !== true && rec.stopped !== true && (agentRunning || fresh)
        const childPresent = listed || childAlive
        // 认领来的记录（或落盘时没记过 startedAt 的记录）没有本地历史，永远等不到
        // subagent/end。它一旦不再 running 就是跑完了，必须当结束处理并释放占用，
        // 否则一次早就跑完的审核会把单条门禁永久锁住。
        const listedOnly = rec.adopted === true || text(rec.startedAt) === ''
        const finishedAdopted = listedOnly && !agentRunning
        let resultFile = ''
        let htmlFile = ''
        let caseName = ''
        let casePath = rec.casePath
        try {
          const root = await defaultRoot()
          // 先试**记住的绝对路径**（上一轮已经定位到的案例目录），再试当前案例根目录。
          // 缺这一步时，一旦用户换了工作空间，defaultRoot() 变了，旧案例就再也
          // 扫不到 —— 交付件明明在磁盘上，界面却退化成"未出结果"。
          const paths = []
          if (casePath) paths.push(casePath)
          if (root) {
            if (rec.seqNo) paths.push(root + '/' + rec.seqNo)
            if (rec.key) paths.push(root + '/' + rec.key)
          }
          for (let j = 0; j < paths.length; j += 1) {
            const target = await resolvePath(paths[j])
            const info = await getFs().stat(target)
            if (info && info.type === 'directory') {
              const item = await inspectCase(target)
              if (item && item.resultFile) {
                resultFile = item.resultFile
                htmlFile = item.htmlFile
                caseName = item.name
                casePath = item.path
                break
              }
              if (item && !casePath) casePath = item.path
              if (item && !htmlFile) htmlFile = item.htmlFile
            }
          }
        } catch (error) { /* 尚未开始 */ }
        // 判定顺序有讲究：**先看这次子会话自己的生命周期，再看磁盘上的交付件**。
        // 反过来的话，「重新审核」会立刻踩坑：它写的是同一个案例目录，上一轮的
        // 审核结果 JSON 还在，先看文件就会把正在跑的新审核显示成"已出结果"。
        let status = 'running'
        if (rec.stopped === true) status = 'stopped'
        else if (rec.ended === true || finishedAdopted) {
          // 已结束：有交付件就是 done；没有时，正常跑完（completed）/ 被外部取消
          // （aborted）不算失败，标成 idle 说"未出结果"，只有 error / max-tokens 才是 failed。
          status = resultFile ? 'done'
            : ((rec.endReason === 'completed' || rec.endReason === 'aborted' || finishedAdopted) ? 'idle' : 'failed')
        }
        else if (agentRunning) status = 'running'
        else if (rec.childId) status = resultFile ? 'done' : 'idle'
        else status = resultFile ? 'done' : 'running'
        const nextRec = Object.assign({}, rec, {
          status: status, casePath: casePath, resultFile: resultFile, htmlFile: htmlFile,
          caseName: caseName, activity: act, childAlive: childAlive,
          ended: rec.ended === true || finishedAdopted,
          endReason: rec.endReason || (finishedAdopted ? 'completed' : ''),
        })
        if (rec.status !== status || rec.casePath !== casePath || rec.resultFile !== resultFile
            || rec.ended !== nextRec.ended
            || rec.uploadedAt !== nextRec.uploadedAt || rec.stopReason !== nextRec.stopReason) {
          changed = true
        }
        state.audits[key] = nextRec
        // 占用锁自愈：锁可能因为父会话漂移被误释放（本次事故就是这样：明明还有一条
        // 在跑，却因为查错了父会话而判定"子会话不在了"）。只要这一轮真的看到有子
        // 会话在 running，就把单条门禁重新挂回它身上。
        if (childAlive && !state.activeChildId) {
          state.activeKey = key
          state.activeChildId = rec.childId
          state.activeSince = Date.now()
          changed = true
        }
        // rec.ended 才是权威：idle（正常跑完但还没扫到交付件）同样必须释放占用，
        // 否则「重新审核」会被上一轮的锁永久挡住。
        // childAlive=false 是重装后的常见情况：子会话的 Agent 已经不在了，
        // 那把锁必须松开，否则这条报告再也起不来。
        if (rec.ended === true || !childAlive || finishedAdopted
            || status === 'done' || status === 'failed' || status === 'stopped') {
          releaseActive(rec.childId)
        }
        if (status === 'done' && !nextRec.uploadedAt && !nextRec.uploading) {
          maybeAutoUpload(nextRec).catch(function () {})
        }
        out.push(nextRec)
      }
      // 只在真的有变化时落盘：这个接口每 10 秒被轮询一次。
      if (changed) await persistAudits()
      return {
        ok: true, audits: out, parentSessionId: boundParentId,
        active: { key: state.activeKey, childId: state.activeChildId, since: state.activeSince },
      }
    })

    harness.handle('workbench:oss-index', async () => {
      const platform = await detectPlatform()
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const oss = normalizeOss(manifest.oss)
      if (!oss.enabled) return { ok: false, error: '清单里 oss.enabled 不是 true', items: {} }
      if (!oss.bucket) return { ok: false, error: '清单缺 oss.bucket', items: {} }
      const ossutilPath = await resolveOssutil(oss, platform)
      if (!ossutilPath) return { ok: false, error: '未找到 ossutil，请先安装', items: {} }
      // ls 默认就递归列举该前缀下的全部 object；它没有 -r 选项
      // （-d/--directory 才是"只列第一层"）。传 -r 会被 ossutil 直接拒绝。
      const argv = [ossutilPath, 'ls', 'oss://' + oss.bucket + '/' + oss.prefix + '/', '--short-format']
      if (oss.endpoint) argv.push('--endpoint', oss.endpoint)
      const run = await runShell(argv.map(quoteArg).join(' '), undefined, 90000, false, 4 * 1024 * 1024)
      if (!run.ok) {
        const raw = (text(run.stderr) || text(run.error) || text(run.stdout) || '列举失败').trim()
        return { ok: false, error: raw.slice(0, 400), items: {} }
      }
      const keys = parseLsObjects(run.stdout, oss.bucket)
      const items = {}
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]
        const seq = seqNoFromKey(key, oss.prefix)
        if (!seq) continue
        if (!items[seq]) items[seq] = { seqNo: seq, files: [], htmlKey: '', jsonKey: '' }
        const name = fileNameOf(key)
        items[seq].files.push({ key: key, name: name })
        if (/\.html?$/i.test(name)) items[seq].htmlKey = key
        else if (/\.json$/i.test(name)) items[seq].jsonKey = key
      }
      return { ok: true, bucket: oss.bucket, prefix: oss.prefix, count: keys.length, items: items, truncated: run.truncated === true }
    })

    harness.handle('workbench:oss-link', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const key = text(a.key)
      if (!key) return { ok: false, error: '缺少对象 key' }
      const platform = await detectPlatform()
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const oss = normalizeOss(manifest.oss)
      if (!oss.bucket) return { ok: false, error: '清单缺 oss.bucket' }
      const cloud = 'oss://' + oss.bucket + '/' + key
      let url = ''
      if (oss.linkMode === 'public') {
        const base = text(oss.publicBaseUrl).replace(/\/+$/, '')
        if (!base) return { ok: false, error: '清单 linkMode=public 但 publicBaseUrl 为空' }
        url = base + '/' + key.split('/').map(function (seg) { return encodeURIComponent(seg) }).join('/')
      } else {
        const ossutilPath = await resolveOssutil(oss, platform)
        if (!ossutilPath) return { ok: false, error: '未找到 ossutil' }
        const argv = [ossutilPath, 'sign', cloud, '--timeout', String(oss.linkTtl)]
        if (oss.endpoint) argv.push('--endpoint', oss.endpoint)
        const run = await runShell(argv.map(quoteArg).join(' '), undefined, 30000, false)
        if (!run.ok) {
          return { ok: false, error: (text(run.stderr) || text(run.error) || '签名失败').slice(0, 300) }
        }
        url = parseSignUrl(run.stdout)
        if (!url) return { ok: false, error: '签名命令没有输出 URL：' + text(run.stdout).slice(0, 200) }
      }
      // 签名只覆盖路径与查询参数、不含协议（实测 http→https 仍为 200）。
      // 链接里带 bearer 签名，能拿到就能看，所以不要走明文。
      if (url.indexOf('http://') === 0) url = 'https://' + url.slice(7)
      let opened = false
      let openError = ''
      let cmd = ''
      if (platform.indexOf('darwin') === 0) cmd = 'open ' + quoteArg(url)
      else if (platform.indexOf('win32') === 0) cmd = 'cmd /c start "" ' + quoteArg(url)
      else cmd = 'xdg-open ' + quoteArg(url)
      const openRun = await runShell(cmd, undefined, 30000, true)
      opened = openRun.ok === true
      if (!opened) openError = (text(openRun.stderr) || text(openRun.error) || '打开命令未成功').slice(0, 200)
      return { ok: true, url: url, mode: oss.linkMode, ttl: oss.linkTtl, opened: opened, openError: openError }
    })

    harness.handle('workbench:open-path', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const path = text(a.path)
      if (!path) return { ok: false, error: '缺少路径' }
      const f = getFs()
      if (f === undefined) return { ok: false, error: 'Host 文件服务不可用' }
      try {
        const root = await defaultRoot()
        const target = await resolvePath(path)
        if (root) {
          const rootTarget = await resolvePath(root)
          if (f.contains(rootTarget, target) !== true) return { ok: false, error: '只允许打开案例根目录内的文件' }
        }
        const info = await f.stat(target)
        if (!info || info.type !== 'file') return { ok: false, error: '目标不是文件：' + path }
      } catch (error) {
        return { ok: false, error: '路径解析失败：' + failureMessage(error) }
      }
      const platform = await detectPlatform()
      let cmd = ''
      if (platform.indexOf('darwin') === 0) cmd = 'open ' + quoteArg(path)
      else if (platform.indexOf('win32') === 0) cmd = 'cmd /c start "" ' + quoteArg(path)
      else cmd = 'xdg-open ' + quoteArg(path)
      const run = await runShell(cmd, undefined, 30000, true)
      return {
        ok: run.ok === true, path: path, platform: platform,
        error: run.ok === true ? '' : (text(run.stderr) || text(run.error) || '打开命令未成功').slice(0, 300),
      }
    })

    harness.handle('workbench:env', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const platform = await detectPlatform()
      const loaded = await loadManifest(a.source)
      state.manifest = loaded.manifest
      await ensureRegistry()
      await ensureWorkspace()
      const home = await homeDir()
      const checks = await probeEnv(loaded.manifest, platform)
      const ifindKey = await probeIfindKey(loaded.manifest, home)
      const declared = arr(loaded.manifest.services)
      const requiredOf = function (id, dflt) {
        const hit = declared.filter(function (s) { return s.id === id })[0]
        return hit ? hit.required !== false : dflt
      }
      const services = []

      const sessionRun = await runCrwu(['crwu', 'h3yun', 'session', 'status'], undefined, 20000, false)
      const sview = sessionView(parseJsonLoose(sessionRun.stdout))
      let h3Expired = false
      if (sview && sview.expiresAt) {
        const t = Date.parse(sview.expiresAt)
        if (!isNaN(t)) h3Expired = t <= Date.now()
      }
      services.push({
        id: 'h3yun', label: '氚云（H3Yun）员工会话', required: requiredOf('h3yun', true),
        ok: !!(sview && !h3Expired),
        state: !sview ? '未绑定' : (h3Expired ? '已过期' : '正常'),
        detail: sview ? ('userId ' + text(sview.userId) + ' · 到期 ' + text(sview.expiresAt)) : (sessionRun.stderr || sessionRun.error || '未取得会话状态'),
      })

      const dwsRun = await runShell('dws auth status --format json', undefined, 30000, false)
      const ddoc = parseJsonLoose(dwsRun.stdout)
      services.push({
        id: 'dingtalk', label: '钉钉认证', required: requiredOf('dingtalk', true),
        ok: !!(ddoc && ddoc.authenticated === true),
        state: ddoc ? (ddoc.authenticated === true ? '已登录' : '未登录') : '未知',
        detail: ddoc && ddoc.message ? text(ddoc.message) : (dwsRun.stderr || dwsRun.error || ''),
      })

      const oss = normalizeOss(loaded.manifest.oss)
      const ossProbe = await probeOss(oss, requiredOf('oss', true), platform)
      services.push(ossProbe)

      const want = declared.map((s) => text(s.id))
      const filtered = want.length > 0 ? services.filter((s) => want.indexOf(s.id) >= 0) : services
      const blocked = checks.filter((c) => c.required && !c.ok).map((c) => c.name)
        .concat(filtered.filter((s) => s.required && !s.ok).map((s) => s.label))
      if (ifindKey && ifindKey.required && !ifindKey.ok) blocked.push('iFinD 密钥')
      if (!state.workspaceChosen) {
        const prefer = (loaded.manifest.workspace || BUILTIN_MANIFEST.workspace)
        blocked.unshift('未找到工作空间「' + text(prefer.preferTitle) + '」，请手动选择')
      }
      if (!platform) blocked.unshift('运行平台未识别')

      const ossutilCheck = checks.filter((c) => c.name === oss.ossutil)[0]

      return {
        ok: true,
        manifestSource: loaded.source,
        manifestKind: loaded.kind,
        manifestLoaded: loaded.loaded,
        manifestError: loaded.error,
        manifestUpdatedAt: text(loaded.manifest.updatedAt),
        installDocUrl: text(loaded.manifest.installDocUrl) || DEFAULT_INSTALL_DOC,
        checks: checks,
        ifindKey: ifindKey,
        services: filtered,
        blocked: blocked,
        allOk: blocked.length === 0,
        home: home,
        platform: platform,
        trust: { h3yun: state.trustH3yun },
        workspace: workspaceView(),
        sessionWorkspace: sessionWorkspaceInfo(),
        oss: Object.assign({}, oss, { ossutilReady: !!(ossutilCheck && ossutilCheck.found), probe: ossProbe }),
        ossCred: await readOssCred(),
      }
    })

    harness.handle('workbench:dws-login', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const argv = ['dws', 'auth', 'login']
      if (a.device === true) argv.push('--device')
      const run = await runShell(argv.map(quoteArg).join(' '), undefined, 300000, true)
      return { ok: run.ok === true, error: run.error || '', timedOut: run.timedOut === true, stdoutTail: text(run.stdout).slice(-600), stderrTail: text(run.stderr).slice(-600) }
    })

    harness.handle('workbench:session', async () => {
      const run = await runCrwu(['crwu', 'h3yun', 'session', 'status'], undefined, 20000, false)
      return { ok: run.ok === true, session: sessionView(parseJsonLoose(run.stdout)), error: run.ok === true ? '' : describeFailure(run) }
    })

    harness.handle('workbench:relogin', async () => {
      const run = await runCrwu(['crwu', 'h3yun', 'session', 'login'], undefined, 300000, true)
      return {
        ok: run.ok === true, session: sessionView(parseJsonLoose(run.stdout)),
        error: run.error || '', timedOut: run.timedOut === true,
        stdoutTail: text(run.stdout).slice(-600), stderrTail: text(run.stderr).slice(-600),
      }
    })

    // 手动重传 OSS。按审计记录的 key 定位案例目录（也就用得上 audit-status
    // 记住的那个绝对 casePath），而不是让调用方传路径 —— 界面只知道 key。
    harness.handle('workbench:oss-upload', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      const key = text(a.key)
      const rec = key ? state.audits[key] : null
      const casePath = text(a.casePath) || (rec && rec.casePath) || ''
      if (!casePath) return { ok: false, error: '这条审核还没定位到案例目录，无法重传。' }
      const platform = await detectPlatform()
      const manifest = state.manifest || normalizeManifest(BUILTIN_MANIFEST)
      const oss = normalizeOss(manifest.oss)
      if (!oss.enabled) return { ok: false, error: 'OSS 回传未启用：请在远程清单里把 oss.enabled 设为 true。' }
      if (!oss.bucket) return { ok: false, error: 'OSS 回传缺少 bucket。' }
      const ossutilPath = await resolveOssutil(oss, platform)
      if (!ossutilPath) return { ok: false, error: '未找到 ossutil。请先在环境自检页让 Agent 安装。' }
      let item = null
      try {
        const target = await resolvePath(casePath)
        item = await inspectCase(target)
      } catch (error) { item = null }
      if (!item) return { ok: false, error: '案例目录不可读或不是案例：' + casePath }
      const projectId = key || text(a.projectId) || item.name
      const out = await uploadArtifacts(item, projectId, oss, ossutilPath)
      if (rec) {
        if (out.ok) {
          rec.uploadedAt = new Date().toISOString()
          rec.uploadError = ''
          rec.ossPrefix = text(out.prefix)
        } else {
          rec.uploadError = text(out.error).slice(0, 300) || '上传失败'
        }
      }
      return out
    })

    harness.handle('workbench:pending', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      let escalated = false
      if (!state.formCode) {
        const found = await discoverForm(DEFAULT_FORM_NAME, a.escalate === true)
        if (!found.ok) {
          return { ok: false, error: found.error, rows: [], formName: '', escalateAvailable: !!(found.run && found.run.escalateAvailable) }
        }
        state.formCode = found.code
        state.formName = found.name
        escalated = found.run && found.run.escalated === true
      }
      const page = num(a.page) > 0 ? Math.floor(num(a.page)) : 1
      const size = num(a.size) > 0 ? Math.min(100, Math.floor(num(a.size))) : 20
      const built = buildQueryFilter(a.query)
      if (built.mode === 'invalid') {
        return { ok: false, error: '报告流水号不能包含引号或反斜杠', rows: [], formName: state.formName, escalateAvailable: false }
      }
      const argv = ['crwu', 'h3yun', 'records', 'list', '--schema', state.formCode, '--page', String(page), '--size', String(size)]
      if (built.expr) argv.push('--filter', built.expr)
      const run = await runCrwu(argv, undefined, 90000, a.escalate === true, RECORDS_STDOUT_MAX)
      if (run.escalated === true) escalated = true
      const payload = parseJsonLoose(run.stdout)
      if (!payload) {
        return { ok: false, error: describeFailure(run), rows: [], formName: state.formName, escalateAvailable: run.escalateAvailable === true }
      }
      const rows = rowsFromEnvelope(payload).map(rowToTask)
      return {
        ok: true, formName: state.formName, rows: rows,
        page: page, size: size, total: totalFromEnvelope(payload),
        query: text(a.query), filterMode: built.mode,
        escalated: escalated, escalateAvailable: false,
      }
    })

    harness.handle('workbench:crwu', async (args) => {
      const a = args && typeof args === 'object' ? args : {}
      return await runCrwu(a.argv, text(a.workdir), a.timeoutMs, a.escalate === true)
    })

    console.log('中瑞世联工作台 Host 半已装配 ' + JSON.stringify({
      rev: 'pkg-42',
      ws: typeof resolveAuditWorkspace === 'function' && typeof ensureWorkspace === 'function' && typeof sessionWorkspaceInfo === 'function',
      wsView: typeof workspaceView === 'function',
      promptRoot: typeof auditPrompt === 'function' && auditPrompt.toString().indexOf('本案例的唯一根目录是') > 0,
      manifestWs: BUILTIN_MANIFEST.workspace.preferTitle,
    }))
  },
}
