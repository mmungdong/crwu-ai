import { text as asText } from '../../shared/utils/value.ts'

/**
 * 安装提示词全文。
 *
 * **这段文本是从动态形态实现逐字搬过来的（该形态已删除，见 `PORTING.md`），不要改写措辞。** 它是交给**另一个 agent**
 * 的作业指令，那个 agent 会照着它在本机装 CLI、写配置、处理密钥。措辞里有两处是安全相关的，
 * 早先我手写改写时把它们弄丢了：
 *
 * - 「不要尝试、不要兜底、不要试探连通性」—— GitHub 在本环境按不可达处理，去探测会白等；
 * - 「清单里的下载地址、校验要求、目录约定、硬性约束都以它为准」—— 声明安装清单是**唯一权威**，
 *   否则 agent 会凭经验发明安装方式。
 *
 * 所以这段文字只允许整段搬运，不允许"意思差不多"地重写。
 */

/** 没有远程清单时的兜底安装文档地址。 */
export const DEFAULT_INSTALL_DOC = 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-install.md'

function legacyInstallPrompt(url: unknown, workspacePath: unknown): string {
  const L = []
  L.push('请完成本机 crwu 审核环境的安装。')
  L.push('')
  L.push('**第一步：先完整阅读这份安装清单 —— ' + asText(url) + '**')
  L.push('')
  L.push('然后**严格按它的步骤逐条执行**。不要凭经验跳步，不要自己发明安装方式；清单里的下载地址、校验要求、目录约定、硬性约束都以它为准。')
  L.push('')
  L.push('几条必须遵守的：')
  L.push('1. **先检查、只装缺的**：已经装好且可用的项直接跳过，不要重装。')
  L.push('2. **GitHub 一律按不可达处理**：不要尝试、不要兜底、不要试探连通性。需要的东西只能从 GitHub 获得时停下来问我。')
  L.push('3. **密钥、令牌一律不要回显**到对话或日志里。')
  L.push('4. **每一项都要实际验证**（跑版本命令、看真实输出），不要凭推理判断成功。')
  if (asText(workspacePath)) {
    L.push('5. 需要临时文件时放在当前工作空间 `' + asText(workspacePath) + '` 下，不要写系统目录。')
  }
  L.push('')
  L.push('完成后**逐项回报**：每项的实际状态（新装/已存在）、实际下载地址、安装后的绝对路径、验证命令的真实输出；以及任何跳过或失败的项目和原因。')
  return L.join('\n')
}

/** 只做类型收窄的包装；文本一字不改。 */
export function buildInstallPromptText(url: unknown, workspacePath: unknown): string {
  return legacyInstallPrompt(url, workspacePath)
}
