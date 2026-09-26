/** Host 与 Client 共用的同源工作台端点。 */
export const WORKBENCH_ROUTE = '/api/crwu-workbench'

/**
 * 宿主插件与客户端产物的**协议代数**。
 *
 * 两侧是**分开加载**的：客户端产物随页面刷新就换新，宿主产物只有重启 profile 才会换。
 * 于是很容易出现「界面是新的、逻辑是旧的」——审核挂错会话那次就是这么来的（用户看到新按钮、
 * 跑的是老代码，报障说「还是挂错位置」）。
 *
 * 12：`env` 的返回从 `checks[]` 混装改成**语义分区**：`packageIntegrity`（② 插件内置组件，只按包内
 *    文件与包内清单字节数核对）/ `runtime`（③ DSH 自带 Python 运行时）/ `services`（④ 氚云 + 钉钉，
 *    **不再含 oss**）/ `delivery`（⑤ OSS 配置 + 凭据 + 连通性）/ `external`（⑥ iFinD），
 *    `checks` / `ifindKey` / 顶层 `oss` 整体消失。语义上有三处**行为变化**，必须靠协议号喊出来：
 *    1. 裸 `python3` 不再是检查项 —— 运行时只认 DSH 自带（缺了是 capability gap，不是「未安装」）；
 *    2. 三件随包组件不再走 PATH、不跑版本命令，缺了只说「插件包不完整 / 平台不受支持」；
 *       `blocked` 里它们从三条变一条（`插件内置组件`），vendored dws 的 PATH 兼容性不再阻断自动审核；
 *    3. `env` 接受 `{ refresh?: boolean }`（界面「重新自检」传）刷新运行时缓存。
 *    界面新、宿主旧时，旧宿主仍会回 `checks[]` 与新客户端不认的字段 —— 新界面读到 `undefined`
 *    只会画出一整页「未配置」的假故障，所以这一代必须由协议号自己喊出来（§7.12）。
 * 11：`env.checks` 里**不再有 `node`**（清单把它整个移除：crwu/dws/ossutil 都是原生二进制、
 *    技能脚本是 Python，node 从来不是依赖），`python3` 是唯一的运行时必需项。
 *    字段形状没变，但**语义变了**：旧宿主会把 node 当成必需项并把它放进 `blocked`，
 *    界面于是显示「还差 node」—— 而磁盘上的新产物已经不看 node 了。
 *    实测踩到：宿主比产物旧一版时，客户端因为形状没变而不报警，安静地显示一个假阻塞项。
 *    所以这里必须 +1，让「界面是新的、宿主是旧的」由协议号自己喊出来（§7.12）。
 * 10：`env` 的**清单来源字段整组消失**（`manifestSource` / `manifestKind` / `manifestLoaded` /
 *    `manifestError` / `manifestUpdatedAt` / `installDocUrl`），换成 `configSource`（部署 YAML 路径）；
 *    `EnvCheckView` 去掉 `url` / `sha256` / `target`，`install-prompt` 的 `url` 恒为空。
 *    原因见 CHANGELOG：只读 OSS 分发桶整体下掉，二进制随包发布、插件改从 npm 安装。
 *    旧宿主仍会回那六个字段（客户端不读即可），但**新宿主回的字段旧客户端不认** ——
 *    所以这一代必须靠协议号把「界面是新的、宿主是旧的」挡在门外。
 * 9：`oss-index` 改用 `ossutil ls` 的**长格式**（一次列举就带回 size / lastModified / **ETag**），
 *    `CloudItem.files[]` 与 `report-files` 的 `oss[]` / `local[]`（DSH fs 的 `version` 令牌）随之带上元数据
 *    —— 这些是"审核结果 / 报告资料有没有变过"的客观依据；旧宿主不传时客户端按缺失处理。
 * 8：`oss-result` 的摘要新增两组**裁剪字段**（`issues[]`、`reviewComparison.reviewItems[]`），
 *    抽屉的「AI 检出问题」与「已提未改」直接读它们 —— 旧宿主不给时抽屉降级（不显示这两块）。
 *
 * 规则：**每次改动跨进程契约（Host 操作的字段/语义、审核父级这类关键行为）就把这里 +1**，
 * `ping` / `boot` 会带上它；客户端发现不一致就明说「宿主是旧构建，请重启 profile」并停发起审核，
 * 而不是拿旧逻辑干新活。
 */
export const WORKBENCH_PROTOCOL = 12

/**
 * 报告流水号（SeqNo）的形状：`2026-301705-LX10170-BG8746`。
 *
 * 为什么放共享常量：Host 拿它当**安全边界**（流水号会被拼进 OSS 路径，不校验的话 `../` 能越出
 * 配置前缀），Client 拿它做即时校验（不合形状就不发请求、直接给人话提示）。两边各写一份正则
 * 必然漂移，所以只此一份。
 *
 * 规则：`<4 位年>-<数字>-<字母数字与 ._- >`；**不含 `/`**、**不含 `..`**、长度 ≤ 128。
 */
export const SEQ_NO_PATTERN = /^\d{4}-\d+-[0-9A-Za-z][0-9A-Za-z._-]*$/
export const SEQ_NO_MAX_LENGTH = 128

/** 这个流水号能不能安全地当作 OSS 路径的一段（Host 与 Client 同一个判据）。 */
export function isSafeSeqNo(value: string): boolean {
  const raw = value.trim()
  return raw !== '' && raw.length <= SEQ_NO_MAX_LENGTH && SEQ_NO_PATTERN.test(raw) && !raw.includes('..')
}
