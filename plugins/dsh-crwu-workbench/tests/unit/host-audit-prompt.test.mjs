/**
 * 审核指令（`host/audit/prompt.ts` 的 `auditPrompt`）的逐条测试。
 *
 * 为什么必须逐条钉住：这段文本是**交给子会话的作业指令**，少写一步，子会话就会少做一步，
 * 而表现是「审核结果看起来正常但缺东西」。用户 2026-09-20 报的「skill 给钉钉文档上传的
 * 已经不生效了」就是这一类 —— 技能 SOP 里有步骤 15（钉钉结果回传），但指令里从来没写，
 * 子会话做完指令里明确写着「完成后必须……」的那一次 OSS 上传就收尾了；而且技能里的
 * `python3 scripts/upload_audit_result.py`（相对路径）在案例目录里根本跑不起来。
 *
 * 所以每个交付动作在这里都有一条断言：**删掉指令里的任何一步，这里必须变红。**
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../', import.meta.url)

const { auditPrompt } = await import(new URL('src/host/audit/prompt.ts', ROOT).href)

const SEQ = '2026-301705-LX10170-BG8746'
const WORKSPACE = '/Users/mungdong/中瑞世联工作空间'
const OSS = { bucket: 'crwu-bucket', prefix: 'crwu/audit', endpoint: 'oss-cn-beijing.aliyuncs.com', enabled: true }

function task(patch = {}) {
  return {
    objectId: 'obj-1', seqNo: SEQ, project: '某某资产评估项目',
    workspace: WORKSPACE, oss: OSS, isRetry: false,
    ...patch,
  }
}

test('审核指令带上案例目录与两个绝对路径要求', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes(`**本案例目录必须是：${WORKSPACE}/${SEQ}**`), true, '案例目录要写在指令里（子会话 cwd 继承父会话，没法用 cwd 表达）')
  assert.equal(text.includes('`--case` 参数一律传这个**绝对路径**'), true, '技能脚本的 --case 必须是绝对路径')
  assert.equal(text.includes('不要**在当前工作目录下创建案例目录'), true, '不许另建案例目录')
})

test('重新审核时指令明确「不许读上一轮的产物」', () => {
  const text = auditPrompt(task({ isRetry: true }))
  assert.equal(text.includes('这是**重新审核**，不是接着上一轮继续'), true)
  for (const name of ['findings/', '审核意见.*.json', '审核结果.*.json', '冻结快照.json', '材料盘点.json']) {
    assert.equal(text.includes(name), true, `重审清单里要有 ${name}`)
  }
  assert.equal(text.includes('复核-人工/'), true, '人工复核记录一律不得读取')
})

test('审核指令给出 OSS 上传命令与「实际校验」要求', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('## 完成后必须把交付件上传到 OSS'), true)
  assert.equal(text.includes(`ossutil cp -f "${WORKSPACE}/${SEQ}/审核意见.${SEQ}.html" "oss://crwu-bucket/crwu/audit/${SEQ}/审核意见.${SEQ}.html"`), true)
  assert.equal(text.includes(`ossutil cp -f "${WORKSPACE}/${SEQ}/审核结果.${SEQ}.json"`), true)
  assert.equal(text.includes(`ossutil ls "oss://crwu-bucket/crwu/audit/${SEQ}/"`), true, '上传后必须真的列一遍校验，不能只看退出码')
  assert.equal(text.includes('不要问我要 AccessKey'), true, '凭据提示要在（否则子会话会来问密钥）')
})

test('审核指令给出钉钉结果回传（技能脚本绝对路径 + 成功判据 + 失败语义）', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('## 交付后的两件钉钉回传（都要做，不许跳过）'), true, '这两件必须写成显式步骤')
  assert.equal(text.includes('### 1. 钉钉结果回传（团队空间归档）'), true)
  // 脚本随插件包发布，所以路径必须解析到**包内自研层**技能目录：员工机器上是
  // `<profile>/node_modules/dsh-crwu-workbench/skills/crwu/…`，开发机上是仓库里的同一层。
  // 写死 `~/.dsh/skills/…`（插件化之前的写法）在员工机器上不存在，那一步会直接跑不起来。
  const upload = fileURLToPath(new URL('skills/crwu/crwu-audit/scripts/upload_audit_result.py', ROOT))
  assert.equal(existsSync(upload), true, '技能脚本必须真的随包发布（package.json 的 files 要有 skills/crwu/）')
  assert.equal(
    text.includes(`python3 "${upload}" "${WORKSPACE}/${SEQ}/审核结果.${SEQ}.json"`),
    true,
    '脚本要用**包内绝对路径**（技能里那句相对路径在案例目录跑不起来）',
  )
  assert.equal(text.includes('~/.dsh/skills'), false, '不许再写死 ~/.dsh/skills（插件化后那里没有技能）')
  assert.equal(text.includes('references/13-dingtalk-result-publish.md'), true, '要指向技能里的回传契约')
  assert.equal(text.includes('`ok:true`'), true, '成功判据是标准输出那个 JSON 的 ok:true')
  assert.equal(text.includes('remotePath'), true)
  assert.equal(text.includes('nodeId'), true)
  assert.equal(text.includes('钉钉回传失败'), true, '失败要显式汇报，不许静默略过')
  assert.equal(text.includes('不要切 `dws` profile'), true)
})

test('审核指令给出「发 HTML 到自己的单聊 + 把那条消息 DING 一下」的完整命令链', () => {
  const text = auditPrompt(task())
  assert.equal(text.includes('### 2. 把 HTML 发到自己的钉钉单聊，并把那条消息 DING 一下'), true)
  assert.equal(text.includes('dws contact user get-self --format json'), true, '自己的 userId 要用真实命令取，不许写死')
  assert.equal(text.includes('dws aisearch person --query'), true, 'openDingTalkId 同样要解析')
  assert.equal(text.includes(`cd "${WORKSPACE}/${SEQ}"`), true, '--file 只接受工作目录内相对路径，所以要先 cd 进案例目录')
  assert.equal(
    text.includes(`dws chat +messages-send --as user --user <我的 userId> --msg-type file --file "审核意见.${SEQ}.html" --format json`),
    true,
    '发文件消息的命令要完整可抄',
  )
  assert.equal(text.includes('dws chat +chat-messages --user <我的 userId> --page-size 2 --format json'), true, '要取回 conversationId / messageId 才能把消息转 DING')
  assert.equal(
    text.includes('dws ding message send-by-message --group <conversationId> --message-id <messageId> --users <我的 openDingTalkId> --type app --format json'),
    true,
    'DING 走「把那条消息转 DING」，且默认应用内（免费）',
  )
  assert.equal(text.includes('`openDingId`'), true, 'DING 的成功判据是真实 openDingId')
  assert.equal(text.includes('一个案例**只发一次**'), true, '失败不许反复重发（否则就是 DING 轰炸）')
})

test('回传只送结果 JSON、按年月归档，且时间戳必须带时区', () => {
  // 用户 2026-09-20 明确：钉钉结果回传**只需要 JSON**，而且归档要**按年月分开**。
  // 年月不是插件算的，是脚本按 `auditTask.auditTime` 分的；实测三条真实 JSON 里有一条
  // 只写了日期（`2026-09-20`），脚本直接拒绝：「auditTask.auditTime 必须包含时区」——
  // 所以指令里必须把「只传 JSON / 按年月 / 时间戳带时区」都写清楚。
  const text = auditPrompt(task())
  assert.equal(text.includes('只回传 `审核结果.<项目ID>.json` 这一个文件'), true, '回传区只放结果 JSON')
  assert.equal(text.includes('HTML 与其它任何产物都不要传进团队空间'), true, 'HTML 不进回传区')
  assert.equal(text.includes('按 `auditTask.auditTime` 的**年/月自动分开**'), true, '年月是归档维度')
  assert.equal(text.includes('AI资产评估审核结果/YYYY/MM/'), true, '要写出归档路径形状')
  assert.equal(text.includes('必须是带时区的完整 ISO 8601'), true, '时间戳格式是硬要求')
  assert.equal(text.includes('2026-09-20T10:35:52+08:00'), true, '要给出一个正确样例')
  assert.equal(text.includes('auditTask.auditTime 必须包含时区'), true, '把真实报错写进去，子会话才自查得到')

  // 回传脚本那一行只能出现 JSON，不能把 HTML 也塞进去。
  const scriptLine = text.split('\n').find((line) => line.includes('upload_audit_result.py')) ?? ''
  assert.match(scriptLine, /审核结果\..*\.json"/, '脚本吃的是结果 JSON')
  assert.equal(/\.html/i.test(scriptLine), false, '回传命令里不许出现 HTML')
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
