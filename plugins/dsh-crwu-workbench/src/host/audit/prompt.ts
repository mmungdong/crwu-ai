import { text as asText } from '../../shared/utils/value.ts'
import type { OssSpec } from '../environment/manifest-default.ts'
import { packageSkillPath } from './skill-paths.ts'

/**
 * 审核指令全文（交给子会话 / crwu-audit 技能的作业指令）。
 *
 * 它必须把**每一步交付都说全**：案例目录与 `--case` 绝对路径、重审的「不许读旧产物」、
 * OSS 上传、以及钉钉那两件回传（团队空间归档 + 把 HTML 发到自己的单聊并转成 DING）。
 * 只写「按技能执行」是不够的 —— 子会话会跑到一个明确写着「完成后必须……」的段落就收尾，
 * 技能 SOP 里的后续步骤不会自动被执行（用户 2026-09-20 报的就是「skill 给钉钉文档上传的
 * 已经不生效了」）。所以这里的每一步都有 `tests/unit/host-audit-prompt.test.mjs` 逐条断言，
 * 改文本时先看那份测试。
 *
 * 另一条来自实测的约束：技能里的回传命令写的是相对路径 `scripts/upload_audit_result.py`，
 * 而子会话的 cwd 是工作空间、不是技能目录 —— 所以这里给**绝对路径**，否则那一步跑不起来。
 *
 * 为什么不用 cwd 表达「在工作空间里做」：子会话的 cwd 只能继承父会话（in-process 驱动
 * 用 childSessionMeta(parent) 构造，没有覆盖入口），所以只能把**绝对路径**写进指令。
 */

/**
 * 钉钉结果回传脚本的绝对路径（脚本随本插件包发布，见 `packageSkillPath`）。
 * 解析不到时退回 `$SKILLS_ROOT` 占位（`$SKILLS_ROOT` 指 `crwu` 层技能根，见 `cordis.patch.yml`）：
 * 指令文本不该因为路径解析失败而少掉一整段交付动作。
 */
const DINGTALK_UPLOAD_SCRIPT =
  packageSkillPath('crwu-audit/scripts/upload_audit_result.py') || '$SKILLS_ROOT/crwu-audit/scripts/upload_audit_result.py'

export interface AuditPromptTask {
  objectId: string
  seqNo: string
  project: string
  workspace: string
  oss: OssSpec | null
  isRetry: boolean
}

interface LegacyTask {
  objectId?: unknown
  seqNo?: unknown
  project?: unknown
  workspace?: unknown
  oss?: unknown
  isRetry?: unknown
}

function legacyAuditPrompt(task: LegacyTask) {
  const ws = asText(task.workspace).replace(/\/+$/, '')
  const seq = asText(task.seqNo)
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
  // 类型收窄（原 legacy 是 JS 真值判断；文本不改，只给它一个准确类型）。
  const oss: OssSpec | null = task.oss !== null && typeof task.oss === 'object' ? task.oss as OssSpec : null
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

  // 钉钉这两件**不挂在 OSS 分支下**：没配 OSS 时同样要做。用户报过「skill 给钉钉文档上传的
  // 已经不生效」，根因就是这段以前根本不存在 —— 子会话做完上面那次 OSS 上传就收尾了。
  if (seq !== '') {
    const dir = caseDir === '' ? '<案例目录>' : caseDir
    L.push('')
    L.push('## 交付后的两件钉钉回传（都要做，不许跳过）')
    L.push('')
    L.push('审核结果 JSON 与 HTML 都生成好之后，除了上面那次 OSS 上传，还必须做完下面两件，并在汇报里给出每一步的原始输出。')
    L.push('')
    L.push('### 1. 钉钉结果回传（团队空间归档）')
    L.push('')
    L.push('按 crwu-audit 技能的 `references/13-dingtalk-result-publish.md` 执行。用**技能的绝对路径**调用脚本（子会话的 cwd 是工作空间、不是技能目录，写相对路径会跑不起来）：')
    L.push('')
    L.push('```bash')
    L.push('python3 "' + DINGTALK_UPLOAD_SCRIPT + '" "' + dir + '/审核结果.' + seq + '.json"')
    L.push('```')
    L.push('')
    L.push('要求：')
    L.push('1. 组织、团队空间、结果根目录、`YYYY/MM` 目录全部由脚本按契约精确解析，**不要自己改目标、不要切 `dws` profile**。')
    L.push('2. 成功判据是**标准输出的单个 JSON 且 `ok:true`**（含 `remotePath`、`nodeId`），不是「退出码好看」就算过。')
    L.push('3. 脚本非零退出或输出不是那个 JSON 时：把**原始输出**贴进汇报，并明确写「钉钉回传失败」，不要静默略过、不要自己改道重试。')
    L.push('4. 回传失败**不影响**本地交付件与上面那次 OSS 上传，两者互不阻塞。')
    L.push('5. **只回传 `审核结果.<项目ID>.json` 这一个文件** —— HTML 与其它任何产物都不要传进团队空间（那里只放结果 JSON）。')
    L.push('6. 归档目录由脚本按 `auditTask.auditTime` 的**年/月自动分开**（`AI资产评估审核结果/YYYY/MM/`），不要自己指定或另建目录。')
    L.push('7. 因此 JSON 里 `auditTask.auditTime` 与 `fileTrace.generatedAt` **必须是带时区的完整 ISO 8601**，形如 `2026-09-20T10:35:52+08:00`。只写日期（`2026-09-20`）或不带时区，脚本会按契约直接拒绝回传 —— 实测报错是「auditTask.auditTime 必须包含时区：2026-09-20」；偏移也写成 `+08:00` 这种带冒号的形式。')
    L.push('')
    L.push('### 2. 把 HTML 发到自己的钉钉单聊，并把那条消息 DING 一下')
    L.push('')
    L.push('`dws` 已在 PATH 里。每一步的稳定 ID 都必须来自真实命令返回，**不要写死、不要猜**；当前 profile 若不是中瑞世联，显式加 `--profile <corpId:userId>`，**不要持久切换 profile**。')
    L.push('')
    L.push('```bash')
    L.push('# ① 我自己的稳定 ID')
    L.push('dws contact user get-self --format json                                   # → orgEmployeeModel.userId')
    L.push('dws aisearch person --query "<我的姓名>" --dimension name --format json    # → openDingTalkId')
    L.push('')
    L.push('# ② 把 HTML 发到「我自己的单聊」（--file 只接受工作目录内的相对路径，所以先 cd 进案例目录）')
    L.push('cd "' + dir + '"')
    L.push('dws chat +messages-send --as user --user <我的 userId> --msg-type file --file "审核意见.' + seq + '.html" --format json')
    L.push('')
    L.push('# ③ 取刚才那条文件消息的会话 ID 与消息 ID（取最新一条、且 resourceRefs 里正是上面那个文件名的那条）')
    L.push('dws chat +chat-messages --user <我的 userId> --page-size 2 --format json  # → conversationId / messageId')
    L.push('')
    L.push('# ④ 把它转成 DING（app = 应用内 DING，免费；sms / call 有成本，不要用）')
    L.push('dws ding message send-by-message --group <conversationId> --message-id <messageId> --users <我的 openDingTalkId> --type app --format json')
    L.push('```')
    L.push('')
    L.push('要求：')
    L.push('1. 一个案例**只发一次**；任何一步失败就把原始输出贴进汇报，**不要反复重发**。')
    L.push('2. 发消息的成功判据是回执里有投递结果；DING 的成功判据是回执里有**真实 `openDingId`**。没有就按失败汇报。')
    L.push('3. 汇报里写清：回传的 `remotePath` / `nodeId`、文件消息的 `conversationId` / `messageId`、DING 的 `openDingId`。')
  }
  return L.join('\n')
}

/** 只做类型收窄的包装；文本一字不改。 */
export function auditPrompt(task: AuditPromptTask): string {
  return legacyAuditPrompt(task as LegacyTask)
}
