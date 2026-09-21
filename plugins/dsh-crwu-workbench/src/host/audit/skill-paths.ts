import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 本包内技能文件的**绝对路径**。
 *
 * 为什么不能写死路径：技能随插件发布（`cordis.patch.yml` 的 `crwu-workbench-skills` 行把本包
 * `skills/` 与 `common/skills/` 注册成技能根），安装位置随形态变：
 * - 员工机器：`<profile>/node_modules/dsh-crwu-workbench/skills/...`；
 * - 开发机（`link:`）：仓库里的 `plugins/dsh-crwu-workbench/skills/...`。
 *
 * 2026-09 之前的写法是把技能脚本路径**写死在用户级技能根下**（那时技能由 skills-manager 装到
 * 用户目录里，插件只管面板）。插件化之后员工机器上那里根本没有技能目录 —— 指令里的那一步会直接跑不起来。
 *
 * 两个候选对应两种加载形态：构建产物 `lib/index.js`（上一级）与测试直接 import 的
 * `src/host/audit/*.ts`（上三级）。取第一个真实存在的；都不在就回空串，由调用方决定怎么表述 ——
 * 这里不抛错，因为审核指令是**给子会话的文本**，取不到路径也不该让整条指令生成失败。
 */
export function packageSkillPath(relative: string): string {
  for (const candidate of [`../skills/${relative}`, `../../../skills/${relative}`]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  return ''
}
