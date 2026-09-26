/**
 * 审核指令（`host/audit/prompt.ts` 的 `auditPrompt`）的逐条测试。
 *
 * 为什么必须逐条钉住：这段文本是**交给子会话的作业指令**，少写一步，子会话就会少做一步，
 * 而表现是「审核结果看起来正常但缺东西」。用户 2026-09-20 报的「skill 给钉钉文档上传的
 * 已经不生效了」就是这一类 —— 技能 SOP 里有步骤 15（钉钉结果回传），但指令里从来没写，
 * 子会话做完指令里明确写着「完成后必须……」的那一次 OSS 上传就收尾了。
 *
 * **2026-09-25 的改造方向相反，但同样是逐条断言**：自研审核链路只走 CRWU 结构化 Tool，
 * 指令里**不许再出现**插件二进制目录、`export PATH`、`which`/`command -v`、裸
 * `crwu`/`dws`/`ossutil` 命令块，也不许再让子会话跑 Python 回传脚本。
 * 删掉指令里的任何一步、或把裸命令塞回来，这里必须变红。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { auditPrompt } = await import(new URL('src/host/audit/prompt.ts', ROOT).href)
const { REQUIRED_AUDIT_TOOLS } = await import(new URL('src/host/tools/consts.ts', ROOT).href)

const SEQ = '2026-301705-LX10170-BG8746'
const WORKSPACE = '/Users/mungdong/中瑞世联工作空间'
const OSS = { bucket: 'crwu-bucket', prefix: 'crwu/audit', endpoint: 'oss-cn-beijing.aliyuncs.com', enabled: true }

const SNAPSHOT = {
  attemptId: `${SEQ}-a1-abc`,
  dir: `${WORKSPACE}/${SEQ}/输入快照`,
  recordPath: `${WORKSPACE}/${SEQ}/输入快照/报告记录.json`,
  attachmentsPath: `${WORKSPACE}/${SEQ}/输入快照/附件清单.json`,
  metadataPath: `${WORKSPACE}/${SEQ}/输入快照/快照元数据.json`,
  digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  fieldCount: 42,
  attachmentCount: 3,
  objectId: 'obj-1',
  seqNo: SEQ,
}

const PYTHON = {
  path: '/Users/x/Library/Application Support/dsh/runtime/python/bin/python3',
  versionText: '3.12.4',
  distributions: { openpyxl: '3.1.5', pandas: '3.0.1' },
}

function task(patch = {}) {
  return {
    objectId: 'obj-1', seqNo: SEQ, project: '某某资产评估项目',
    workspace: WORKSPACE, oss: OSS, isRetry: false,
    snapshot: SNAPSHOT, python: PYTHON,
    ...patch,
  }
}

test('审核指令带上案例目录与两个绝对路径要求', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes(`**本案例目录必须是：${WORKSPACE}/${SEQ}**`), true, '案例目录要写在指令里（子会话 cwd 继承父会话，没法用 cwd 表达）')
  assert.equal(text.includes('`--case` 参数同样传它'), true, '技能脚本的 --case 必须是绝对路径')
  assert.equal(text.includes('不要**在当前工作目录下创建案例目录'), true, '不许另建案例目录')
})

test('重新审核时指令明确「不许读上一轮的产物」', () => {
  const text = auditPrompt(task({ isRetry: true }))
  assert.equal(text.includes('这是**重新审核**，不是接着上一轮继续'), true)
  for (const name of ['findings/', '审核意见.*.json', '审核结果.*.json', '冻结快照.json', '材料盘点.json', 'knowledge/']) {
    assert.equal(text.includes(name), true, `重审清单里要有 ${name}`)
  }
  assert.equal(text.includes('复核-人工/'), true, '人工复核记录一律不得读取')
})

test('指令顶部列出全部必需 Tool 名，并要求能力缺失时立即报 capability gap', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('## 本链路只允许使用 CRWU 结构化 Tool（硬约束）'), true, '硬约束必须在最前面')
  for (const name of REQUIRED_AUDIT_TOOLS) {
    assert.equal(text.includes('`' + name + '`'), true, `必需 Tool 名要逐字出现：${name}`)
  }
  assert.equal(text.includes('capability gap：缺少 <工具名>'), true, '缺 Tool 要按 capability gap 汇报，不许降级')
  assert.equal(text.includes('vendored 的 DWS 技能'), true, '要声明 vendored DWS 技能不参与本次编排')
})

test('报告定位交接：指令声明以输入快照为唯一记录来源，且不得重新定位', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('## 报告已由 Host 精确定位（不要再定位、不要重复取数）'), true, '这一段是交接契约，必须在')
  // 快照路径与指纹都要给到，子代理才知道读哪儿、以及和哪一份对账
  assert.equal(text.includes(SNAPSHOT.recordPath), true, '完整记录路径')
  assert.equal(text.includes(SNAPSHOT.attachmentsPath), true, '附件清单路径')
  assert.equal(text.includes(SNAPSHOT.metadataPath), true, '快照元数据路径')
  assert.equal(text.includes(SNAPSHOT.digest), true, '快照 digest')
  assert.equal(text.includes(String(SNAPSHOT.fieldCount)), true, '字段数')
  assert.equal(text.includes(String(SNAPSHOT.attachmentCount)), true, '附件数')
  // 规则逐条在
  for (const clause of [
    '**你不需要、也不允许提交或猜测它**',
    '**禁止再次定位或取数**',
    '不要 `records list`',
    '不要在案例目录或其它目录里搜索或复用别的报告的材料',
    '**只按附件清单里的 `fileId`**',
    '数据边界错误：输入快照与任务不符',
  ]) {
    assert.equal(text.includes(clause), true, `交接规则要逐条写明：${clause}`)
  }
  // 重审：快照按新的 attemptId 覆盖，仍不许读旧产物
  const retry = auditPrompt(task({ isRetry: true }))
  assert.equal(retry.includes('输入快照已由 Host 按**新的 attemptId** 重新取数并覆盖'), true)
  assert.equal(retry.includes('复核-人工/'), true)
})

test('脚本运行时：指令只给 DSH 自带 Python 的绝对路径，并禁止 PATH 查找与静默降级', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('## 脚本运行时：只用 DSH 自带的 Python'), true)
  assert.equal(text.includes(PYTHON.path), true, 'DSH Python 绝对路径')
  assert.equal(text.includes('3.12.4'), true, '版本要写出来')
  assert.equal(text.includes('openpyxl 3.1.5'), true, '关键包版本要写出来')
  for (const clause of [
    '**禁止**用裸解释器名字（`python` / `python3`）调用',
    '不要搜索可执行文件、不要读 shell 的环境变量、不要修改 PATH',
    '**禁止**静默降级到系统自带的解释器',
    'capability gap：DSH Python 不可用',
  ]) {
    assert.equal(text.includes(clause), true, `Python 纪律要逐条写明：${clause}`)
  }
})

test('没有快照时指令明确「不要自己去发现表单」，而不是留空', () => {
  const text = auditPrompt(task({ snapshot: null }))
  assert.equal(text.includes('## 输入快照缺失'), true)
  assert.equal(text.includes('直接停止并汇报「输入快照缺失」'), true)
  assert.equal(text.includes('不要**自己去发现表单'), true)
})

test('指令不含任何二进制路径 / PATH 注入 / 查找命令', () => {
  const text = auditPrompt(task())
  // 旧文案的指纹：一个都不许回来。
  assert.equal(/bin\/darwin-arm64|bin\/win32-x64/.test(text), false, '不许出现包内二进制目录')
  assert.equal(/export\s+PATH/.test(text), false, '不许给出 PATH 注入方式')
  assert.equal(text.includes('命令在哪'), false, '「命令在哪」那一段整体删除')
  assert.equal(/\bwhich\b/.test(text), false, '不许出现 which')
  assert.equal(text.includes('command -v'), false, '不许出现 command -v')
  assert.equal(/\bfind\b/.test(text), false, '不许出现 find')
  assert.equal(/^\s*\$?\s*(python3?|bash|sh)\s/m.test(text), false, '不许给出任何 shell 命令块')
  assert.match(text, /不要查找可执行文件/, '要明确禁止搜索二进制')
  assert.match(text, /复制到 `~\/bin`/, '要明确禁止往 ~/bin 拷副本')
})

test('指令不含裸 crwu / dws / ossutil 命令，也不再点名 Python 回传脚本', () => {
  const text = auditPrompt(task())
  // 「裸命令」判据：行首（去掉缩进/代码围栏/编号）就是命令名 —— 那才是"可以让模型照抄的命令"。
  const bare = text.split('\n').filter((line) => /^\s*(crwu|dws|ossutil)\s/.test(line))
  assert.deepEqual(bare, [], `不许出现裸业务命令：${bare.join(' | ')}`)
  assert.equal(text.includes('upload_audit_result'), false, '自动审核不再点名那个 Python 回传脚本')
  assert.equal(text.includes('subprocess'), false)
})

test('OSS 交付改写成 crwu_audit_oss_publish 调用，并保留写后校验语义', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('## 完成后必须把交付件上传到 OSS（用 `crwu_audit_oss_publish`）'), true)
  assert.equal(text.includes(`crwu_audit_oss_publish({ caseDir: "${WORKSPACE}/${SEQ}", seqNo: "${SEQ}" })`), true, '要给出可直接照抄的调用')
  assert.equal(text.includes('**真的列举一次**核对目标对象与字节数'), true, '写后校验的要求必须留着')
  assert.equal(text.includes('不要问我要 AccessKey'), true, '凭据提示要在（否则子会话会来问密钥）')
  assert.equal(text.includes('不要提交、也不要自己拼 `oss://` 地址'), true, 'bucket/endpoint/prefix 由 Tool 从配置读')
})

test('钉钉归档改写成 crwu_audit_dingtalk_archive，并保留年月与时间戳契约', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('### 1. 钉钉结果回传（团队空间归档）'), true)
  assert.equal(text.includes(`crwu_audit_dingtalk_archive({ caseDir: "${WORKSPACE}/${SEQ}", seqNo: "${SEQ}" })`), true)
  assert.equal(text.includes('`ok:true`'), true, '成功判据是 Tool 返回的结构化 ok:true')
  assert.equal(text.includes('remotePath'), true)
  assert.equal(text.includes('nodeId'), true)
  assert.equal(text.includes('钉钉回传失败'), true, '失败要显式汇报，不许静默略过')
  assert.equal(text.includes('不要切 `dws` profile'), true)
  assert.equal(text.includes(`只回传 \`审核结果.${SEQ}.json\` 这一个文件`), true, '回传区只放结果 JSON')
  assert.equal(text.includes('按 `auditTask.auditTime` 的**年/月自动分开**'), true, '年月是归档维度')
  assert.equal(text.includes('AI资产评估审核结果/YYYY/MM/'), true, '要写出归档路径形状')
  assert.equal(text.includes('必须是带时区的完整 ISO 8601'), true, '时间戳格式是硬要求')
  assert.equal(text.includes('2026-09-20T10:35:52+08:00'), true, '要给出一个正确样例')
  assert.equal(text.includes('auditTask.auditTime 必须包含时区'), true, '把真实报错写进去，子会话才自查得到')
})

test('通知改写成 crwu_audit_dingtalk_notify_self，并保留幂等与「不用 sms/call」', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('### 2. 把 HTML 发到自己的钉钉单聊，并把那条消息 DING 一下'), true)
  assert.equal(text.includes(`crwu_audit_dingtalk_notify_self({ caseDir: "${WORKSPACE}/${SEQ}", seqNo: "${SEQ}" })`), true)
  assert.equal(text.includes('一个案例**只发一次**'), true, '失败不许反复重发（否则就是 DING 轰炸）')
  assert.equal(text.includes('`alreadySent:true`'), true, '幂等由 Tool 保证，要写清它的返回值')
  assert.equal(text.includes('**应用内**（免费）'), true, 'DING 默认应用内')
  assert.equal(text.includes('`sms` / `call`'), true, '明确禁用有成本的通道')
  for (const field of ['userId', 'openDingTalkId', 'conversationId', 'messageId', 'openDingId']) {
    assert.equal(text.includes(field), true, `稳定 ID 字段要写全：${field}`)
  }
})

test('没配 OSS 时钉钉那两件回传仍然要在指令里', () => {
  // 这条盯的是「步骤别挂在 OSS 分支下」：OSS 是可选交付，钉钉回传不是。
  const text = auditPrompt(task({ oss: null }))
  assert.equal(text.includes('## 完成后必须把交付件上传到 OSS'), false, '没配 OSS 就不该有 OSS 那一段')
  assert.equal(text.includes('### 1. 钉钉结果回传（团队空间归档）'), true, 'OSS 关掉了，钉钉回传照样要做')
  assert.equal(text.includes('### 2. 把 HTML 发到自己的钉钉单聊，并把那条消息 DING 一下'), true)
})

test('重新审核时两件钉钉回传不会被重审那一段挤掉', () => {
  const text = auditPrompt(task({ isRetry: true }))
  assert.equal(text.includes('### 1. 钉钉结果回传（团队空间归档）'), true)
  assert.equal(text.includes('### 2. 把 HTML 发到自己的钉钉单聊，并把那条消息 DING 一下'), true)
  assert.equal(text.includes('按 crwu-audit 技能执行完整两阶段审核流程'), true, '两阶段流程本身不能被重审说明取代')
})

test('缺少 workspace 时不编造案例目录', () => {
  const text = auditPrompt(task({ workspace: '', seqNo: '' }))
  assert.equal(text.includes('本案例目录必须是'), false)
  assert.equal(text.includes('crwu_audit_oss_publish({'), false, '没有案例目录就没有可执行的交付调用')
  assert.equal(text.includes('## 本链路只允许使用 CRWU 结构化 Tool（硬约束）'), true, '工具约束与案例目录无关，必须还在')
})
