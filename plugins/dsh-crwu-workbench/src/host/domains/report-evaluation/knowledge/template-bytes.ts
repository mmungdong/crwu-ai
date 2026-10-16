/**
 * **计算表模板**下载字节的最低限度验真。
 *
 * ## 为什么必须验，而不是"下载下来就用"
 *
 * 模板是数值口径的载体：表序、公式链、输入区位置全在里面。取回一份 HTML 错误页 / 登录页 /
 * 被网关改写的响应时，按 xlsx 打开才失败 —— 而那时人已经在填表。所以字节一到手就先判形态。
 *
 * ## 为什么只剩两条判据
 *
 * 原来还有"与索引声明的字节数 / sha256 对得上"。manifest 已经取代了模板索引，而 manifest
 * 只声明**指针**（路径），不声明字节指纹（设计稿 §4.1）。既然没有声明值可比，"不符即拒绝"
 * 就无从谈起 —— 留一个永远通过的检查只会让人以为验过了。
 *
 * 现在还剩下的两道门：
 * - 非空；
 * - 前四字节是 ZIP 魔数 `PK\x03\x04`（xlsx 就是 ZIP）。
 *
 * **结构合同不在这里**："可见表、无隐藏表、无跨簿链接、公式链不断"由模板自己的填写说明
 * （descriptor）声明，并由技能自带的 `check_workbook_contract.py` 回答。
 * 这一层只保证"拿到的是 xlsx 字节"，然后把它交给那个脚本。
 */

export interface TemplateByteCheck {
  ok: boolean
  problems: string[]
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/** 对取回的模板字节做最低限度验真。`label` 用于把失败说清是哪一份。 */
export function verifyTemplateWorkbook(bytes: Uint8Array | null, label: string): TemplateByteCheck {
  if (bytes === null || bytes.length === 0) {
    return { ok: false, problems: [`模板 ${label} 下载得到 0 字节：不是一份可用的工作簿`] }
  }
  const isZip = ZIP_MAGIC.every((byte, index) => bytes[index] === byte)
  if (!isZip) {
    return {
      ok: false,
      problems: [`模板 ${label} 的字节不是 ZIP/xlsx（前四字节不是 PK\\x03\\x04）：`
        + '很可能取回的是错误页或登录页，不要按工作簿打开'],
    }
  }
  return { ok: true, problems: [] }
}
