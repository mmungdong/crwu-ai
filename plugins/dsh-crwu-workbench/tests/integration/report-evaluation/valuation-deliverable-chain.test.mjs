/**
 * 源仓契约测试（integration）：把四件交付件**串起来**跑一遍。
 *
 * 为什么单独有一层：各脚本自己的用例都过了，也不代表**它们之间**对得上 ——
 * `extract_files.py` 提取出的字段、`build_workbook.py` 接受的值 JSON、`build_report.py`
 * 读的结果 JSON、`validate_result.py` 核对的交付件，四者之间的**接口**在各自的用例里
 * 都是被夹具"喂"出来的。任何一处改名或改形状，单脚本用例照样全绿。
 *
 * 这一层跑的是真实链路（真 .docx / 真 .xlsx / 真模板 / 真 xlsx 产物）：
 *
 *   资料（docx + xlsx）→ extract_files.py → 提取字段
 *     → build_workbook.py（把值填进模板）→ check_workbook_contract.py
 *     → build_report.py（渲染 HTML）→ validate_result.py --html --workbook
 *
 * 声明：源仓契约测试。技能目录不在时跳过（技能可被单独拷走，那时这层没有意义）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const SKILL = join(PLUGIN, 'skills/biz/crwu-biz-valuation-realestate')
const SCRIPTS = join(SKILL, 'scripts')
const TEMPLATE = join(SKILL, 'template/valuation-workbook.xlsx')

/**
 * 用哪个 Python 跑技能脚本。
 *
 * 优先 `CRWU_PYTHON`，其次 **DSH 自带运行时**（生产就是这么跑的：`deps.python` 解析到的就是它），
 * 最后才退回 `python3`。**不写死绝对路径**（`src/host/core/runtime/python.ts` 明确不硬编码
 * `~/.dsh/dsh-runtimes`），所以这里按 glob 找，找不到就跳过 —— 跳过要好过用错解释器得出假结论。
 */
function pickPython() {
  if (process.env.CRWU_PYTHON !== undefined && process.env.CRWU_PYTHON !== '') return process.env.CRWU_PYTHON
  const home = process.env.HOME ?? ''
  const roots = home === '' ? [] : [join(home, '.dsh/dsh-runtimes')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const candidate = join(root, name, 'dependencies/python/bin/python3')
      if (existsSync(candidate)) return candidate
    }
  }
  return 'python3'
}

const PYTHON = pickPython()

function run(script, args, options = {}) {
  return execFileSync(PYTHON, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    ...options,
  })
}

function hasPython() {
  try {
    execFileSync(PYTHON, ['-c', 'import openpyxl, docx'], { stdio: 'ignore' })
    return true
  } catch (error) {
    void error
    return false
  }
}

test('交付件链路：资料 → 提取 → 底稿 → 报告 → 校验，一条链跑通', { skip: !existsSync(SKILL) }, (t) => {
  if (!hasPython()) {
    t.skip('本机 Python 缺 openpyxl / python-docx（技能脚本的运行前提）')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'crwu-chain-'))
  try {
    // ① 造真实资料：一份 docx（正文 + 表格）与一份 xlsx（表格）。
    const docxPath = join(dir, '评估对象说明.docx')
    const xlsxPath = join(dir, '面积与价格.xlsx')
    execFileSync(PYTHON, ['-c', `
import docx, openpyxl
d = docx.Document()
d.add_paragraph('坐落：示例路 1 号')
d.add_paragraph('用途：住宅')
d.add_paragraph('建筑面积：120.5 平方米')
d.add_paragraph('建成年代：2008 年')
t = d.add_table(rows=2, cols=2)
t.cell(0, 0).text = '项目'; t.cell(0, 1).text = '数值'
t.cell(1, 0).text = '楼层'; t.cell(1, 1).text = '6'
d.save(${JSON.stringify(docxPath)})
w = openpyxl.Workbook(); ws = w.active; ws.title = '面积'
ws.append(['权证编号', '建筑面积']); ws.append(['X-1', 120.5])
w.save(${JSON.stringify(xlsxPath)})
`], { stdio: 'ignore' })

    // ② 提取：字段必须**来自资料原文**，不是猜的。
    //
    // ⚠️ 提取结果写在**输出文件**里，不读 stdout —— 表格可能很大，被截断的 JSON 会变成
    // "解析失败"这种误导性结论（`python-extractor.ts` 有同样的注释）。第一版这里读 stdout，
    // 于是只会得到"Unexpected end of JSON input"。
    const docxOut = join(dir, '提取-docx.json')
    run('extract_files.py', [docxPath, docxOut])
    const extracted = JSON.parse(readFileSync(docxOut, 'utf8'))
    assert.equal(extracted.extractedFields['坐落'], '示例路 1 号')
    assert.equal(extracted.extractedFields['用途'], '住宅')
    assert.equal(extracted.error, '', '这份 docx 应当能正常提取')

    const xlsxOut = join(dir, '提取-xlsx.json')
    run('extract_files.py', [xlsxPath, xlsxOut])
    const extractedXlsx = JSON.parse(readFileSync(xlsxOut, 'utf8'))
    assert.equal(extractedXlsx.tables.length >= 1, true, 'xlsx 的表格应当被读出来')
    assert.deepEqual(extractedXlsx.tables[0].rows[0], ['权证编号', '建筑面积'])

    // ③ 底稿：把提取到的值填进模板（只填输入区）。
    //
    // ⚠️ `extractedFields` 里的值一律是**原文**（"120.5 平方米"），直接 `Number(...)` 会得到 NaN，
    // 而 `JSON.stringify(NaN)` **静默变成 `null`** → 底稿那一格空着 → 汇总表没有结论
    // （`check_method_agreement` 也会因为"没有面积的行"而整条跳过）。所以这一步必须真的解析，
    // 并把解析结果断言出来：链路的"牙齿"就在这里。
    const area = Number.parseFloat(String(extracted.extractedFields['建筑面积']).replace(/[^\d.]/g, ''))
    assert.equal(Number.isFinite(area), true, `建筑面积要从原文里解析成数字：${extracted.extractedFields['建筑面积']}`)
    const valuesPath = join(dir, '填入值.json')
    writeFileSync(valuesPath, JSON.stringify({
      cells: {
        '基础信息表!B5': extracted.extractedFields['坐落'],
        '基础信息表!B7': area,
        '收益法!C9': 4.5,
        '估值结果汇总!F5': area,
        '估值结果汇总!J5': '收益法',
      },
    }), 'utf8')
    const workbookPath = join(dir, '估值底稿.xlsx')
    run('build_workbook.py', ['--values', valuesPath, '--out', workbookPath, '--template', TEMPLATE])
    // 底稿必须过契约（七张可见表、公式链还在、采用的方法逐字）。
    const contract = run('check_workbook_contract.py', [workbookPath])
    assert.match(contract, /^OK:/m)
    // 底稿里**真的**有面积与方法（不然下面那条方法一致性检查会因为"没有数据行"而整条跳过，
    // 于是链路测试变成一条永远绿的摆设 —— 这是它第一版的真实教训）。
    const wrote = run('build_workbook.py', ['--values', valuesPath, '--out', join(dir, '底稿-复核.xlsx'), '--template', TEMPLATE])
    assert.match(wrote, /填入 [1-9]/, '至少要真的填进去一项')

    // ④ 报告：渲染 + 与结果 JSON 逐字对数字。
    const resultPath = join(dir, '估值结果.json')
    writeFileSync(resultPath, JSON.stringify({
      valuationId: '估值-链路-1', method: 'income', methodReason: '租金资料充分',
      // 方法判断记录（§7.2）：采用 + 其他方法为什么不采用。
      methodScreening: [
        { method: 'income', verdict: 'adopted', reason: '有租赁合同与完整租金序列' },
        { method: 'market', verdict: 'not-adopted', reason: '同小区无可核成交案例' },
        { method: 'cost', verdict: 'not-adopted', reason: '对象为投资性房地产，收益法数据充分' },
      ],
      methodConflict: null,
      baseDate: '2026-06-30', unitPrice: 42000, totalValue: 5061000, pricingArea: 120.5, priceUnit: '元/㎡',
      manual_confirmation_items: [], capability_gaps: [],
      knowledge_sources: [{ route: '估值与测算/房地产/03-收益法', source: 'local', updatedAt: '', digest: 'sha256:a' }],
      cases: [],
      artifacts: { html: '估值报告.html', xlsx: '估值底稿.xlsx', json: '估值结果.json' },
    }, null, 2), 'utf8')
    const reportPath = join(dir, '估值报告.html')
    run('build_report.py', ['--result', resultPath, '--out', reportPath])
    const report = readFileSync(reportPath, 'utf8')
    assert.equal(report.includes('{{'), false, '模板占位符必须全部被替换')
    assert.match(report, /42,?000|42000/, '报告里必须出现单价')

    // ⑤ 校验：报告 ↔ JSON 严格、JSON ↔ 底稿的方法一致、底稿结构与错误值。
    const validated = run('validate_result.py', [resultPath, '--html', reportPath, '--workbook', workbookPath])
    assert.match(validated, /OK|通过/, `校验应当通过：\n${validated}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
