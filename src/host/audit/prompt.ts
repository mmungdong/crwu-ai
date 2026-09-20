import { text as asText } from '../../shared/utils/value.ts'
import type { OssSpec } from '../environment/manifest-default.ts'

/**
 * 审核指令全文。
 *
 * **这段文本是从 动态形态实现逐字搬过来的（该形态已删除，迁移记录见 `PORTING.md`），不要改写措辞。** 它是交给子会话
 * （crwu-audit 技能）的作业指令：案例目录、`--case` 绝对路径、重审的「不许读旧产物」、
 * OSS 上传参数与校验要求都在里面。改一个字就可能让子会话少做一步，而表现为
 * 「审核结果看起来正常但缺东西」。
 *
 * 为什么不用 cwd 表达「在工作空间里做」：子会话的 cwd 只能继承父会话（in-process 驱动
 * 用 childSessionMeta(parent) 构造，没有覆盖入口），所以只能把**绝对路径**写进指令。
 */

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
  return L.join('\n')
}

/** 只做类型收窄的包装；文本一字不改。 */
export function auditPrompt(task: AuditPromptTask): string {
  return legacyAuditPrompt(task as LegacyTask)
}
