import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 技能在包内的**分层目录**（层 = 一个 DSH 技能根，见 `cordis.patch.yml`）。
 *
 * 审核指令只引用 `crwu` 层：本文件解决的是「本包自研技能的脚本在哪」，与随包 vendored 的
 * `dws` 层、跨插件的 `common` 层无关 —— 层名因此留在这里的唯一一处常量里，不再散写 `skills/…`。
 */
const CRWU_SKILLS_LAYER = 'skills/crwu'

/**
 * 本包内技能文件的**绝对路径**（`<技能名>/<技能内相对路径>`）。
 *
 * 为什么不能写死路径：技能随插件发布，安装位置随形态变：
 * - 员工机器：`<profile>/node_modules/dsh-crwu-workbench/skills/crwu/...`；
 * - 开发机（`link:`）：仓库里的 `plugins/dsh-crwu-workbench/skills/crwu/...`。
 *
 * 2026-09 之前的写法是把技能脚本路径**写死在用户级技能根下**（那时技能由 skills-manager 装到
 * 用户目录里，插件只管面板）。插件化之后员工机器上那里根本没有技能目录 —— 指令里的那一步会直接跑不起来。
 *
 * 两个候选对应两种加载形态：构建产物 `lib/index.js`（上一级）与测试直接 import 的
 * `src/host/audit/*.ts`（上三级）。取第一个真实存在的；都不在就回空串，由调用方决定怎么表述 ——
 * 这里不抛错，因为审核指令是**给子会话的文本**，取不到路径也不该让整条指令生成失败。
 */
export function packageSkillPath(relative: string): string {
  for (const candidate of [`../${CRWU_SKILLS_LAYER}/${relative}`, `../../../${CRWU_SKILLS_LAYER}/${relative}`]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  return ''
}
