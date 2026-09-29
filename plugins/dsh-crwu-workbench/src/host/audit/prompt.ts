import { text as asText } from '../../shared/utils/value.ts'
import type { OssSpec } from '../environment/manifest-default.ts'
import { REQUIRED_AUDIT_TOOLS } from '../tools/consts.ts'
import { caseDirOf } from '../../shared/utils/case-dir.ts'

/**
 * 审核指令全文（交给子会话 / crwu-audit 技能的作业指令）。
 *
 * 它必须把**每一步交付都说全**：案例目录、重审的「不许读旧产物」、OSS 上传、
 * 以及钉钉那两件回传（团队空间归档 + 把 HTML 发到自己的单聊并转成 DING）。
 * 只写「按技能执行」是不够的 —— 子会话会跑到一个明确写着「完成后必须……」的段落就收尾，
 * 技能 SOP 里的后续步骤不会自动被执行（用户 2026-09-20 报的就是「skill 给钉钉文档上传的
 * 已经不生效了」）。所以这里的每一步都有 `tests/unit/host-audit-prompt.test.mjs` 逐条断言，
 * 改文本时先看那份测试。
 *
 * **2026-09-25 起的硬约束**：自研审核链路的取数与交付只走 CRWU 结构化 Tool。
 * 指令里**不再出现**插件二进制目录、`export PATH`、`<binDir>/dws`、裸 `crwu`/`dws`/`ossutil`
 * 命令块，也不再让子会话跑 `upload_audit_result.py`（那个脚本里的 `subprocess.run(["dws", …])`
 * 就是这条链路上最后一个绕过 `ctx.shell` 的执行点）。
 *
 * 为什么不用 cwd 表达「在工作空间里做」：子会话的 cwd 只能继承父会话（in-process 驱动
 * 用 childSessionMeta(parent) 构造，没有覆盖入口），所以只能把**绝对路径**写进指令。
 */

/**
 * Host 在创建子代理**之前**取回并落盘的输入快照。
 *
 * 它是一次「交接」：`schemaCode` 是 Host 的基础设施状态，子代理既不提交也不需要它 ——
 * 记录与附件元数据已经按精确 `objectId` 取好放在磁盘上（完整记录不进模型上下文）。
 */
export interface AuditInputSnapshot {
  attemptId: string
  /** 快照目录（`<案例目录>/输入快照`）。 */
  dir: string
  recordPath: string
  attachmentsPath: string
  metadataPath: string
  digest: string
  fieldCount: number
  attachmentCount: number
  objectId: string
  seqNo: string
}

/** DSH 自带 Python（审核脚本的运行时）；路径只能来自 `load_workspace_dependencies`。 */
export interface AuditPythonRuntime {
  path: string
  versionText: string
  distributions: Record<string, string>
}

export interface AuditPromptTask {
  objectId: string
  seqNo: string
  project: string
  workspace: string
  oss: OssSpec | null
  isRetry: boolean
  /** 本轮 attemptId（重审每轮都新）。 */
  attemptId?: string
  /** Host 已准备的输入快照；为空表示这一步没做成（那种情况下审核根本不该启动）。 */
  snapshot?: AuditInputSnapshot | null
  /** 已解析的 DSH Python；为空表示没解析成功（同样不该启动）。 */
  python?: AuditPythonRuntime | null
}

interface LegacyTask {
  objectId?: unknown
  seqNo?: unknown
  project?: unknown
  workspace?: unknown
  oss?: unknown
  isRetry?: unknown
  attemptId?: unknown
  snapshot?: unknown
  python?: unknown
}

/** 工具清单那一段：名字逐字来自 `tools/consts.ts`，避免两处漂移。 */
function toolSection(): string[] {
  return [
    '## 本链路只允许使用 CRWU 结构化 Tool（硬约束）',
    '',
    '自研审核链路的取数与交付**必须**调用下面这些由工作台 Host 注册的工具；它们已经在你的工具表里（看不到就按本节的失败规则处理）：',
    '',
    ...REQUIRED_AUDIT_TOOLS.map((name) => `- \`${name}\``),
    '',
    '其中 `crwu_audit_case_bootstrap` **本轮已经由 Host 调用过**（记录与附件元数据就在下面的输入快照里）：',
    '不要再调它，也不要调 `crwu_h3yun_record_get` / `crwu_h3yun_files_list` 重新取数 —— 直接读快照文件。',
    '',
    '**禁止**：',
    '',
    '1. 运行裸 `crwu` / `dws` / `ossutil` 命令 —— 它们不在你的 PATH 里，也不该由你拼命令行。',
    '2. 在系统里搜索、定位或「修好」这些命令：不要查找可执行文件、不要修改 shell 的环境变量、不要把命令复制到 `~/bin`、不要猜二进制路径或包内目录。',
    '3. 用任何脚本或手工命令行替代下面的 Tool（包括随技能发布的 Python 回传脚本）。',
    '',
    '**失败规则（必须照做）**：上面任何一个 Tool 不在你的工具表里，或调用返回能力缺失（`capability gap`）时，**立即停止该步骤并在汇报里写明「capability gap：缺少 <工具名>」**。不要降级成 shell 查找、不要改道裸命令、不要假装成功。',
    '',
    '随包 vendored 的 DWS 技能（`dingtalk-*`）**不参与**本次自动审核编排：自动审核的取数与交付只走上表 Tool。',
    '',
    // 协议 18 · C4：未登录 / 未允许本机访问时**停下并要求用户回工作台**，
    // 绝不许子代理自己去登录 —— 子代理的审批策略被钉成 `never`，任何交互式登录在它这里
    // 都会卡在一个永远不会有人回答的地方；而且登录要写员工的本机凭据，那不是审核该做的事。
    '**登录与授权（必须照做）**：任何 Tool 返回「需要先允许工作台访问本机账号和配置」'
      + '（`not-authorized`）或「未登录 / 会话过期」时：**立即停止本次审核**，在汇报里写明'
      + '「需要员工回到工作台完成账号连接（氚云 / 钉钉）或允许本机访问」，并把已经完成的步骤列清楚。',
    '',
    '**绝对不许**：自己执行登录（`login` 类命令 / 打开浏览器扫码 / 让用户扫码）、'
      + '去系统钥匙串或用户目录里翻找凭据、改 `PATH` 或去找别的命令、把「登录失败」当成本次审核的结论。'
      + '你的审批策略是 `never`：任何需要审批的动作都只会被确定性拒绝。',
    '',
  ]
}

/**
 * 「报告已由 Host 定位」那一段（2026-09-25）。
 *
 * 用户报的缺陷：审核启动只把 objectId/seqNo/project 交给子代理，而记录接口要 `schemaCode`，
 * 于是子代理自己去发现表单、列记录、在案例目录里翻找材料 —— 既重复取数，也可能读到别的
 * 流水号的过期材料。现在 Host 先取好数、落成输入快照，这一段就是那条交接的**契约**。
 */
function snapshotSection(task: LegacyTask, snapshot: AuditInputSnapshot): string[] {
  return [
    '## 报告已由 Host 精确定位（不要再定位、不要重复取数）',
    '',
    '本轮 attemptId：`' + snapshot.attemptId + '`'
      + (asText(task.attemptId) === '' ? '' : '（Host 记为 ' + asText(task.attemptId) + '）'),
    '',
    'Host 已经用审核记录接口**按精确 ObjectId** 取回这条报告的记录与附件元数据，并落盘成输入快照。'
      + '它是本轮**唯一**的记录来源：',
    '',
    '- 完整记录：`' + snapshot.recordPath + '`（digest `' + snapshot.digest + '`，字段 ' + String(snapshot.fieldCount) + ' 个）',
    '- 附件清单：`' + snapshot.attachmentsPath + '`（附件 ' + String(snapshot.attachmentCount) + ' 件）',
    '- 快照元数据：`' + snapshot.metadataPath + '`（attemptId / objectId / seqNo / 取数时刻 / `schemaCode` 的**指纹**）',
    '',
    '硬性要求：',
    '',
    '1. `schemaCode` 由 Host 解析，快照里只有它的指纹。**你不需要、也不允许提交或猜测它**。',
    '2. **禁止再次定位或取数**：不要 `records list`、不要搜索表单、不要用 `crwu_h3yun_record_get` 重新取记录、不要在案例目录或其它目录里搜索或复用别的报告的材料。记录事实一律以快照文件为准。',
    '3. 附件**只按附件清单里的 `fileId`** 逐件调用 `crwu_h3yun_file_get({ fileId, caseDir, relativePath: "材料-源/<localName>" })`；清单外的附件不存在。**`relativePath` 的最后一段必须用清单里的 `localName`**（形如 `广兴建筑v3__c8ef13b8.zip`）—— 报告里可能挂着两个同名附件，按文件名落盘会让后一件静默覆盖前一件，工具会直接拒绝不带这件附件标识的目标名。',
    '4. **同名附件要当成两件材料**：清单里 `nameTotal > 1` 的条目是**同名但不同 `fileId`** 的附件（可能是重复上传，也可能是两个版本）——逐件下载、逐件核对，不许只留一件、也不许把两件当成同一份。',
    '5. 快照里的 `objectId` / `seqNo` 与任务不一致、或快照缺失/读不出时，**立即停止本次审核**并在汇报里写明「数据边界错误：输入快照与任务不符」，不要继续往下做。',
    '',
  ]
}

/**
 * 「脚本运行时」那一段。
 *
 * 技能脚本要 `openpyxl` 这类包，系统 `python3` 既没有也不受控 —— 所以自动审核里 Python 只有
 * 一个允许的绝对路径，来自 DSH 自带的 workspace runtime（`load_workspace_dependencies`）。
 * 禁止 `command -v` / `which` / `find` / 裸 `python3`，也禁止静默降级。
 */
function pythonSection(runtime: AuditPythonRuntime): string[] {
  const packages = Object.entries(runtime.distributions)
    .filter(([name, version]) => name !== '' && version !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 12)
    .map(([name, version]) => name + ' ' + version)
    .join(' · ')
  return [
    '## 脚本运行时：只用 DSH 自带的 Python',
    '',
    '- 唯一允许的 Python 绝对路径：`' + runtime.path + '`（版本 ' + runtime.versionText + '）',
    ...(packages === '' ? [] : ['- 该运行时已装：' + packages]),
    '',
    '硬性要求：',
    '',
    '1. 技能脚本一律用**这个绝对路径**执行：`' + runtime.path + ' scripts/<文件> <参数>`；仍然经 DSH 的 shell 跑（沙箱与审批照旧）。',
    // 措辞刻意**不写出**具体的查找命令：那段文本本身不许出现可照抄的查找手段
    // （`host-audit-prompt.test.mjs` 有文本守卫盯着 which / command -v / find）。
    '2. **禁止**用裸解释器名字（`python` / `python3`）调用，也**禁止**任何形式的解释器查找：不要搜索可执行文件、不要读 shell 的环境变量、不要修改 PATH。解释器只允许上面那一个绝对路径。',
    '3. **禁止**静默降级到系统自带的解释器：它没有审核脚本需要的包，结果不可信。上面那个路径不可用（不存在 / 执行失败 / 缺包）时**立即停止**并汇报「capability gap：DSH Python 不可用」。',
    '',
  ]
}

/**
 * 「运行时由你在子会话里解析」那一段（宿主没能问到时的替代）。
 *
 * 为什么可以这样：子会话**有 agent 作用域**，能调用 `load_workspace_dependencies` 拿到
 * `python` 绝对路径与已装包清单；而宿主侧（启动 / 环境自检）跑在 `host-background`、
 * 没有会话上下文，调同一个工具只会拿到工具报错（2026-09-29 员工机器实测）。
 * 所以这不是放宽口径，而是把「从哪拿」交给有能力拿到的那一层，并明确禁止任何查找与降级。
 */
function pythonUnresolvedSection(): string[] {
  return [
    '## 脚本运行时：由你在本会话里解析 DSH 自带 Python',
    '',
    '- 宿主这次**没能问到**运行时（它在没有会话作用域时调不到那个工具）—— **这不等于运行时缺失**。',
    '- 你在本会话里有作用域：**自己调用一次 `load_workspace_dependencies` 工具**，取返回里的 `python` 字段作为**唯一允许的解释器绝对路径**；可用 `pythonDistributions` 核对 `openpyxl` 是否已装。',
    '- 仍然**禁止**：任何形式的解释器查找（搜索可执行文件、读 shell 环境变量、改 PATH），以及用裸解释器名字（`python` / `python3`）调用。',
    '- 工具返回里没有 `python`、或它不是可执行文件、或缺 `openpyxl` → **立即停止**并汇报「capability gap：DSH Python 不可用」，不要继续跑脚本。',
    '',
  ]
}

function legacyAuditPrompt(task: LegacyTask) {
  const ws = asText(task.workspace).replace(/\/+$/, '')
  const seq = asText(task.seqNo)
  // 案例目录的约定与客户端讨论提示词**共用一份**（`shared/utils/case-dir.ts`）：
  // 两边各写一次拼接就是 2026-09-25 那次「讨论会话把材料下到 cases/<流水号>」的漂移根源。
  const caseDir = caseDirOf(ws, seq)
  const L = [
    '请审核这条评估报告：氚云报告审核记录 ObjectId「' + (task.objectId || '缺失') + '」，报告流水号「' + seq + '」，项目名称「' + (task.project || '') + '」。',
    '',
    ...toolSection(),
  ]
  const snapshot = snapshotOf(task.snapshot)
  if (snapshot !== null) L.push(...snapshotSection(task, snapshot))
  else {
    // 正常路径不会走到这里（审核启动在 bootstrap 失败时就终止了）。留着是为了「宁可停下来」：
    // 没有快照就没有唯一记录来源，往上补一句让子代理不要自己去发现表单。
    L.push('## 输入快照缺失')
    L.push('')
    L.push('Host 没有为本次审核准备输入快照。**不要**自己去发现表单、列记录或在案例目录里找材料：直接停止并汇报「输入快照缺失」。')
    L.push('')
  }
  const python = pythonOf(task.python)
  if (python !== null) L.push(...pythonSection(python))
  // 宿主**没问到**运行时（启动/自检阶段没有会话作用域）时的替代指令：让子会话自己解析。
  // 这不是「去找解释器」—— 那个工具是唯一允许的来源，它返回的绝对路径是唯一允许的解释器。
  else L.push(...pythonUnresolvedSection())
  if (caseDir) {
    // 协议 19 起：审核根的 cwd **就是本案例目录**，沙箱边界（`workspace-write.workspaceRoot`）
    // 也是它 —— 子会话继承这两者，所以"可写范围"在指令里必须说成案例目录，
    // 而不是工作空间（工作空间里的**其他案例**不属于本次审核，写入会被沙箱拒绝）。
    L.push('**本案例目录（也是你的工作目录与可写范围）：' + caseDir + '**')
    if (ws !== '' && ws !== caseDir) {
      L.push('你所在的工作空间是：' + ws + '；但**可写范围只有上面那个案例目录**。')
    }
    L.push('')
    L.push('硬性要求：')
    L.push('1. 材料、中间产物、交付件全部放在上述案例目录下。')
    L.push('2. 上面那些 CRWU Tool 的 `caseDir` 参数一律传这个**绝对路径**；技能脚本的 `--case` 参数同样传它，不要传相对路径。')
    L.push('3. **不要**在当前工作目录下创建案例目录，也**不要**使用其他默认根目录。')
    L.push('4. **不要**读写同一工作空间里的其他案例目录（它们不属于本次审核；沙箱与 Tool 门禁都会拒绝）。')
    L.push('')
  }
  if (task.isRetry === true) {
    // 重新审核必须是干净的一遍。案例目录里往往躺着上一轮的
    // findings/、审核意见.*.json、冻结快照、材料盘点……如果让子会话
    // 参照它们，等于把上一轮的结论复制一遍，重审就没意义了。
    L.push('## 这是**重新审核**，不是接着上一轮继续')
    L.push('')
    L.push('请把这条报告当成一次**全新的审核**，从零重跑完整两阶段流程：')
    L.push('1. **不要参考、不要复用、不要读取**案例目录里上一轮留下的任何产物 —— 包括 `findings/`、`审核意见.*.json`、`审核意见.*.html`、`审核结果.*.json`、`冻结快照.json`、`冻结指纹.json`、`材料盘点.json`、`媒体索引.json`、`route_profile.json`、`knowledge/` 等。以它们的**文件名**判断即可，不要打开。')
    L.push('2. **材料重新取**：本轮输入快照已由 Host 按**新的 attemptId** 重新取数并覆盖（记录与附件元数据都是最新的），附件用 `crwu_h3yun_file_get` 重新下载，知识文档用 `crwu_audit_knowledge_materialize` 重新下载（这些 Tool 会覆盖同名旧产物，不要基于旧内容做增量更新）。')
    L.push('3. 唯一例外是 `复核-人工/`：那里是人工复核记录，两阶段隔离门禁照旧，**一律不得读取**。')
    L.push('')
    L.push('如果你的流程里有任何一步会去读上述旧文件，跳过它，改按全新审核重新生成。')
    L.push('')
  }
  L.push('按 crwu-audit 技能执行完整两阶段审核流程（阶段一独立审核并冻结，再进入阶段二复核对照）。')
  // 类型收窄（原 legacy 是 JS 真值判断；文本不改，只给它一个准确类型）。
  const oss: OssSpec | null = task.oss !== null && typeof task.oss === 'object' ? task.oss as OssSpec : null
  if (oss && oss.bucket && seq && caseDir) {
    L.push('')
    L.push('## 完成后必须把交付件上传到 OSS（用 `crwu_audit_oss_publish`）')
    L.push('')
    L.push('调用一次：')
    L.push('')
    L.push('```text')
    L.push('crwu_audit_oss_publish({ caseDir: "' + caseDir + '", seqNo: "' + seq + '" })')
    L.push('```')
    L.push('')
    L.push('要求：')
    L.push('1. **HTML 必须上传**（`审核意见.' + seq + '.html`）。结果 JSON（`审核结果.' + seq + '.json`）存在就一并上传；不存在时 Tool 会跳过它，你需要在汇报里说明「结果 JSON 未生成」。')
    L.push('2. bucket / endpoint / 对象前缀由 Tool 从部署配置读取，**不要提交、也不要自己拼 `oss://` 地址**；凭据已经配在本机，**不要问我要 AccessKey，不要回显任何密钥**。')
    L.push('3. Tool 会在上传后**真的列举一次**核对目标对象与字节数；你必须在汇报里写出 Tool 返回的 `key`、`sizeBytes` 与 `ok`。')
    L.push('4. 上传失败**不要静默略过**，把 Tool 返回的 `error` 原文（已脱敏）贴出来。')
  }

  // 钉钉这两件**不挂在 OSS 分支下**：没配 OSS 时同样要做。用户报过「skill 给钉钉文档上传的
  // 已经不生效」，根因就是这段以前根本不存在 —— 子会话做完上面那次 OSS 上传就收尾了。
  if (seq !== '' && caseDir !== '') {
    L.push('')
    L.push('## 交付后的两件钉钉回传（都要做，不许跳过）')
    L.push('')
    L.push('审核结果 JSON 与 HTML 都生成好之后，除了上面那次 OSS 上传，还必须做完下面两件，并在汇报里给出每一步返回的关键字段。')
    L.push('')
    L.push('### 1. 钉钉结果回传（团队空间归档）')
    L.push('')
    L.push('调用一次：')
    L.push('')
    L.push('```text')
    L.push('crwu_audit_dingtalk_archive({ caseDir: "' + caseDir + '", seqNo: "' + seq + '" })')
    L.push('```')
    L.push('')
    L.push('要求：')
    L.push('1. 组织、团队空间、结果根目录、`YYYY/MM` 目录全部由 Tool 按契约精确解析，**不要提交这些标识、不要自己改目标、不要切 `dws` profile**。')
    L.push('2. 成功判据是 Tool 返回的**结构化 JSON 且 `ok:true`**（含 `remotePath`、`nodeId`），不是「退出码好看」就算过。')
    L.push('3. Tool 返回 `ok:false` 时：把返回的 `error` **原文**贴进汇报，并明确写「钉钉回传失败」，不要静默略过、不要自己改道重试（尤其不要手工跑 `dws`）。')
    L.push('4. 回传失败**不影响**本地交付件与上面那次 OSS 上传，两者互不阻塞。')
    L.push('5. **只回传 `审核结果.' + seq + '.json` 这一个文件** —— HTML 与其它任何产物都不要传进团队空间（那里只放结果 JSON）。')
    L.push('6. 归档目录由 Tool 按 `auditTask.auditTime` 的**年/月自动分开**（`AI资产评估审核结果/YYYY/MM/`），不要自己指定或另建目录。')
    L.push('7. 因此 JSON 里 `auditTask.auditTime` 与 `fileTrace.generatedAt` **必须是带时区的完整 ISO 8601**，形如 `2026-09-20T10:35:52+08:00`。只写日期（`2026-09-20`）或不带时区，Tool 会按契约直接拒绝回传 —— 实测报错是「auditTask.auditTime 必须包含时区：2026-09-20」；偏移也写成 `+08:00` 这种带冒号的形式。')
    L.push('')
    L.push('### 2. 把 HTML 发到自己的钉钉单聊，并把那条消息 DING 一下')
    L.push('')
    L.push('调用一次：')
    L.push('')
    L.push('```text')
    L.push('crwu_audit_dingtalk_notify_self({ caseDir: "' + caseDir + '", seqNo: "' + seq + '" })')
    L.push('```')
    L.push('')
    L.push('要求：')
    L.push('1. `userId` / `openDingTalkId` / `conversationId` / `messageId` / `openDingId` 全部由 Tool 从真实返回里解析，**不要写死、不要猜**。')
    L.push('2. 一个案例**只发一次**：Tool 自带幂等（重复调用会返回 `alreadySent:true`），**不要**为了重试反复调用，也**不要**手工重发。')
    L.push('3. DING 固定走**应用内**（免费）；`sms` / `call` 有成本，Tool 不会用，你也不要尝试。')
    L.push('4. Tool 返回 `ok:false` 时把 `error` 原文贴进汇报并写明「钉钉通知失败」；返回 `ok:true` 时在汇报里写出 `conversationId` / `messageId` / `openDingId`。')
  }
  return L.join('\n')
}

export function auditPrompt(task: AuditPromptTask): string {
  return legacyAuditPrompt(task as LegacyTask)
}

/** 任务里的快照字段是外部输入，收窄成明确类型（空/形状不对一律当没有）。 */
function snapshotOf(raw: unknown): AuditInputSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>
  const recordPath = asText(doc.recordPath)
  if (recordPath === '') return null
  return {
    attemptId: asText(doc.attemptId),
    dir: asText(doc.dir),
    recordPath,
    attachmentsPath: asText(doc.attachmentsPath),
    metadataPath: asText(doc.metadataPath),
    digest: asText(doc.digest),
    fieldCount: typeof doc.fieldCount === 'number' ? doc.fieldCount : 0,
    attachmentCount: typeof doc.attachmentCount === 'number' ? doc.attachmentCount : 0,
    objectId: asText(doc.objectId),
    seqNo: asText(doc.seqNo),
  }
}

/** 同上，DSH Python。 */
function pythonOf(raw: unknown): AuditPythonRuntime | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>
  const path = asText(doc.path)
  if (path === '') return null
  const distributions: Record<string, string> = {}
  const source = doc.distributions
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [name, version] of Object.entries(source as Record<string, unknown>)) {
      const value = asText(version)
      if (name !== '' && value !== '') distributions[name] = value
    }
  }
  return { path, versionText: asText(doc.versionText), distributions }
}
