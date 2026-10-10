/** Host 与 Client 共用的同源工作台端点。 */
export const WORKBENCH_ROUTE = '/api/crwu-workbench'

/**
 * 自助更新的四个 Host 操作名（协议 16）。
 *
 * 与 `WORKBENCH_ROUTE` 同级：它们是**跨进程契约**的一部分（Host 的操作表、`boot.ported.done`、
 * 冻结清单与 Task 5 的 Client 门面共用这一份名字，避免各写一遍然后漂移）。
 * 四个操作都返回 `{ ok, check, install }`；安装目标不接受调用方参数（见 `host/update/ops.ts`）。
 */
export const UPDATE_OPERATION_NAMES = [
  'update-status',
  'update-check',
  'update-install',
  'update-cancel',
] as const

/** 员工排障入口：用户公开分享的钉钉个人名片链接（来自名片二维码）。 */
export const DEVELOPER_CONTACT_URL = 'https://n.dingtalk.com/dingding/h5-profile/outside/index.html?fr_source=13&uidCipher=7O4cP9kgKCT4CvRDZlgrxQ%3D%3D&cardToken=dff1f30a70&profile=%40kgDOFH5CaA'

/**
 * 宿主插件与客户端产物的**协议代数**。
 *
 * 两侧是**分开加载**的：客户端产物随页面刷新就换新，宿主产物只有重启 profile 才会换。
 * 于是很容易出现「界面是新的、逻辑是旧的」——审核挂错会话那次就是这么来的（用户看到新按钮、
 * 跑的是老代码，报障说「还是挂错位置」）。
 *
 * 18：**本机访问授权收据 + 授权前零副作用自检**（2026-09-29）。跨进程契约有三处语义变化，
 *    必须靠协议号自己喊出来（照 §7.12 的既有口径）：
 *    ① `env.trust: { credentials: boolean }` 被 `env.localAccess: LocalAccessConsentView` 取代 ——
 *       布尔值回答不了「授的是哪个范围、什么时候授的、范围升级后旧的同意还算不算」；
 *    ② **未授权时不再探测**氚云 / 钉钉 / OSS / iFinD：未授权时读到的「未登录 / 密钥错误」是
 *       受限沙箱造成的**假结论**。旧宿主会在未授权时照样探一遍并显示那些结论，
 *       新界面读不到 `localAccess` 只会显示「需要授权」——语义上是一致的，但
 *       新界面**必须**靠协议号拦住旧宿主（否则旧宿主会把假结论说成真实故障）；
 *    ③ 新增 `local-access-grant` / `local-access-revoke` 两个操作，旧 `trust` 保留一代但
 *       **只回协议不匹配的失败、不再授予任何权限**（旧客户端静默授予新范围是绝对不行的）。
 *    操作清单 33 → 38（两个授权操作 + 只读的 `access-diagnostics` + DWS 目录体检与修复；`tests/helpers/frozen-inventory.mjs` 盯着）。
 * 17：**凭据权限结论结构化**（2026-09-28）。`ifind-credential-save` 与 `oss-cred-save` 的应答里
 *    `chmodOk: boolean` / `chmodError: string` 被 `permission: CredentialPermission`
 *    （`status: verified|inherited|failed` + `mechanism` + `message`）取代。语义上必须喊出来的原因：
 *    Windows 没有 POSIX 权限位、也没有 `chmod`，旧字段在 Windows 上**只能是 `true`** ——
 *    字段名读起来是「chmod 成功了」，界面文案也跟着这么说，员工于是以为凭据文件被 0600 保护着。
 *    新客户端读到旧宿主的 `chmodOk` 会得到「没有结论」，必须靠协议号拦在「发审核」之前；
 *    旧客户端读新宿主的 `permission` 会显示不出权限提示 —— 同样得由协议号喊出来。
 * 16：**自助更新**（2026-09-28）。新增四个 Host 操作 `update-status` / `update-check` /
 *    `update-install` / `update-cancel`（操作清单 29 → 33），统一返回 `{ ok, check, install }`
 *    （`shared/update/types.ts` 的 `UpdateCheckState` / `UpdateInstallState`）：检查结论与安装任务
 *    分开表达，安装的终点只有 `awaiting-restart`。两处必须靠协议号喊出来：
 *    ① 安装成功后**磁盘上的客户端产物已经是新的，而仍在运行的 Host 还是旧的**，两者会短暂不一致；
 *    ② 因此客户端一旦发现协议不一致，就必须拦下新的审核并直接提示
 *       「完全退出并重新打开 DeepSeek Harness」（macOS 关闭窗口不等于退出，要从菜单退出或 Command-Q），
 *       而不是拿旧宿主干新活。旧宿主没有这四个操作，新界面点下去只会拿到 404 ——
 *       这一代同样必须由协议号自己显形。
 * 14：**删除 `install-prompt` 操作**（连同 `src/host/environment/install-prompt.ts` 与界面上的
 *    「复制安装提示词」入口）。为什么这也算契约变更：旧客户端挂载时会调这个操作，新宿主没有它 ——
 *    不靠协议号喊出来的话，用户会看到一条与真实原因无关的「未知 op」报错。同理，
 *    环境信息页 ① 去掉了「在新会话中打开」按钮（纯界面删减，不涉及契约）。
 *    操作清单 30 → 29（`tests/helpers/frozen-inventory.mjs` + `host-operations.test.mjs` 盯着）。
 * 13：`env` 增加 `state`（**统一环境模型**，见 `shared/environment/model.ts`）—— 状态 / 阻塞 /
 *    归属 / 通过率 / 能力 / 门禁结论改由 Host 推出一次，客户端不再自己算。语义上有四处
 *    **行为变化**，必须靠协议号喊出来：
 *    1. iFinD 的 `external.state` 变成五态（未配置 / 已保存未验证 / 已认证 / 认证失败 / 不可达），
 *       且**只有真实探测成功**才是 `authenticated`；
 *    2. iFinD 只在**单独缺失**时把总状态降到 `degraded`，不进 `blocked`、不拦导航
 *       （氚云 / 钉钉 / OSS / 工作空间仍然阻塞）；
 *    3. 「环境就绪」与通过率不再自相矛盾：通过率**只统计必需项**；
 *    4. 导航门禁上提到统一导航层（`navigateModule(target)`），`env` 页永远可进。
 *    另外新增 4 个 Host 操作（`ifind-status` / `ifind-credential-save` / `ifind-credential-clear`
 *    / `ifind-probe`）与 iFinD 凭据改由插件 Host 自己保管。旧宿主回不出 `state`，
 *    新界面会按「不认识 → 不放行」拦下所有需要环境的页面（提示重启 profile）。
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
 * 15：**iFinD 从可选能力改成必需项**（2026-09-26 产品口径）。跨进程契约的语义变了三处：
 *   ① `userSetup.ifind.required` 由 false 变 true、`IfindCheck.required` 同理（进必需项分母）；
 *   ② iFinD 未通过时 `issues` 里有**阻塞项**（`id` = `ifind` / `ifind-external`），
 *      归属按 credential→user / entitlement→admin / infrastructure→system 分派，
 *      于是 `capabilities.global` / `auditCore` / `externalData` 都会跟着变 false
 *      （旧口径里 `externalData` 恒为 true、iFinD 只产生非阻塞 issue、总状态是 degraded）；
 *   ③ OSS 探测结果新增结构化 `errorKind`（`credential` / `permission` / `config` / `infrastructure`）
 *      与 `target`（`oss://bucket/prefix/`，不含凭据），供界面按归因派活。
 *    旧宿主仍在旧语义上工作（iFinD 缺失只降级、perm 与网络不区分），所以必须靠协议号喊出来。
 * 10：`env` 的**清单来源字段整组消失**（`manifestSource` / `manifestKind` / `manifestLoaded` /
 *    `manifestError` / `manifestUpdatedAt` / `installDocUrl`），换成 `configSource`（部署 YAML 路径）；
 *    `EnvCheckView` 去掉 `url` / `sha256` / `target`（该代还有 `install-prompt`，14 代已删除）。
 *    原因见 CHANGELOG：只读 OSS 分发桶整体下掉，二进制随包发布、插件改从 npm 安装。
 *    旧宿主仍会回那六个字段（客户端不读即可），但**新宿主回的字段旧客户端不认** ——
 *    所以这一代必须靠协议号把「界面是新的、宿主是旧的」挡在门外。
 * 9：`oss-index` 改用 `ossutil ls` 的**长格式**（一次列举就带回 size / lastModified / **ETag**），
 *    `CloudItem.files[]` 与 `report-files` 的 `oss[]` / `local[]`（DSH fs 的 `version` 令牌）随之带上元数据
 *    —— 这些是"审核结果 / 报告资料有没有变过"的客观依据；旧宿主不传时客户端按缺失处理。
 * 8：`oss-result` 的摘要新增两组**裁剪字段**（`issues[]`、`reviewComparison.reviewItems[]`），
 *    抽屉的「AI 检出问题」与「已提未改」直接读它们 —— 旧宿主不给时抽屉降级（不显示这两块）。
 *
 * 20：新增 `browser-session-bind`（内置浏览器扫码登录的凭据出口）。这条是**新的跨进程契约**：
 *    客户端把从内嵌浏览器页面里读到的 `h3_token` 经它交给 Host，Host 再走
 *    `crwu h3yun session bind --token-stdin` 落到 OS 凭据存储。旧宿主没有这个操作，
 *    新界面点下去只会 404 —— 必须靠协议号把「界面是新的、宿主是旧的」喊出来。
 * 21：钉钉登录拆成 `dws-login-start` / `dws-login-status`（`dws auth login` 改后台跑）。
 *    旧客户端只知道同步的 `dws-login`：它会在 CLI 还在等浏览器回调时一直阻塞到超时，
 *    拿到的 URL 也没有用。新契约加进来就要 +1，让旧界面被明确挡住而不是白等 5 分钟。
 * 22：**下掉两条登录契约**（2026-09-30）：`browser-session-bind`（氚云内置浏览器扫码的凭据出口）
 *    与 `dws-login-start` / `dws-login-status`（钉钉设备码 / 两阶段登录）整体删除。
 *    DSH 只读取、检查已有凭据：登录由本机 CLI 自己拉起**系统浏览器**完成（`relogin` / `dws-login`），
 *    插件不创建浏览器 Tab、不显示二维码 / 设备码、也不轮询登录进度。
 *    旧界面调这三个操作会 404，所以必须 +1 把它挡在门外（而不是让它白等 5 分钟）。
 * 23：**报告讨论会话的受限材料范围**（2026-09-30）。新增 Host 操作 `discussion-material-open`
 *    （操作清单 38 → 39）：讨论会话不是审核 —— 它没有审核记录，而 `crwu_h3yun_file_get`
 *    原先只认审核 scope，于是讨论里一件材料都取不回来（用户报的第三条故障）。
 *    新契约：客户端在 `ensureDiscussion`（新建**或**恢复）之后、发 kickoff 之前调这条操作，
 *    Host 自己重新取一次附件清单、只把那一批 `fileId` 记进**进程内**白名单，并回传案例目录。
 *    两处必须靠协议号喊出来：
 *    ① 旧宿主没有这条操作，新界面点下去只会 404 —— 而"讨论能取材料"正是这一代的行为；
 *    ② 旧界面不调它，于是讨论会话在新宿主上**仍然取不到附件**（宿主不能替客户端登记：
 *       "哪条会话是讨论"这个事实只有客户端知道）。
 * 24：**审核根会话绑到已选工作空间**（2026-09-30，用户报的第四个故障）。审核根原先由 Host 用
 *    `agents.create({ meta: { cwd: 案例目录 } })` 建，而 DSH 有两条硬规则把两件事钉在一起：
 *    沙箱边界**就是**会话 cwd（`SandboxPolicyService.resolve`），而挂到工作空间下要求
 *    cwd **逐字等于**工作空间路径（`Workspace.attachSession`）。于是审核根永远挂不上去，
 *    只能在侧栏落「未分组」——用户看到的正是这个。现在 cwd = 已选工作空间（与 DSH 自己
 *    "在工作空间下开新会话"、以及本插件"与 DeepSeek 讨论"同一条口径）；
 *    **跨案例隔离改由案例 scope 承担**（`requireAuditScope` 按本轮 `casePath` 精确相等）。
 *    必须 +1 的理由：旧宿主的根 cwd/边界是案例目录 —— 与"审核记录属于哪个案例"无关了，
 *    但侧栏归类与沙箱事实都不同，不能混着一代用。
 * 25：**「授权收据读不出来」从「需要授权」里分出来**（2026-09-30）。`env.localAccess.state`
 *    新增 `unreadable`：收据读盘失败（宿主文件服务不可用 / 探测不到主目录 / 位置不是普通文件 /
 *    读抛错）或文件内容损坏时用它，`missing` 只表示"真的没有收据"。必须 +1 的理由：
 *    旧客户端读到 `unreadable` 会当成 `missing` 显示「需要授权」并把员工指向"再授权一次"——
 *    而读失败时写盘同样是读-改-写，根本落不了盘，员工会陷在"授权成功、界面永远停在需要授权"里。
 *    这正是这一代要断掉的那句话。
 * 27: Page-scoped OSS batches return per-serial results and support request cancellation.
 *     Old Hosts must not receive seqNos because they interpret it as an unscoped listing.
 * 26: Manual sessions can use case tools within the selected workspace; managed scopes stay bound.
 *     The handoff now prepares a fresh input snapshot before running the audit.
 * 31：**「查看报告」的打开动作改由客户端发起**（2026-10-11，用户实测"浏览器很慢"）。
 *    `oss-link` 新增可选入参 `open: false`（只回链接、不拉起浏览器），客户端拿到链接后
 *    自己 `window.open`（桌面端主进程会转成 `shell.openExternal` → 系统默认浏览器）。
 *    少一次串行的提权进程。字段是**向后兼容**的（旧宿主忽略它、照旧自己打开并回
 *    `opened: true`，新客户端看到 `opened === true` 就不再开第二个窗口），但仍然 +1 ——
 *    "跨进程行为变了就升协议号"这条规则不留例外，否则下次没人分得清哪一代在跑。
 * 30：**本地审核的选择展开与逐个移除**（2026-10-11，用户第二次口径）。
 *    `local-audit-status` 的应答新增 `files[]`（文件级清单，带 `parentPath`），
 *    两条本地审核操作都新增可选入参 `excluded[]`（排除清单，重扫后仍生效）。
 *    旧宿主没有这两样：新界面会看不到文件行、也移除不掉单个文件 —— 必须 +1 让协议号喊出来。
 * 29：**本地审核的会话落点与交接字段**（2026-10-11，用户第一次真机审核后）。
 *    `local-audit-start` 的应答新增 `workspacePath`，并**改变 `casePath` 的含义**：
 *    案例目录从系统临时目录移到 `<已选工作空间>/本地审核/<handoffId>`，新会话的 cwd 也
 *    从 `casePath` 改成 `workspacePath`。必须 +1：旧宿主**不回这个字段**，新客户端会拿一个
 *    空 cwd 去建会话，真机上表现为一句莫名其妙的
 *    `failed to ensure project directory "": ENOENT: mkdir ''`（用户实测踩到）——
 *    这正是协议号该替他喊出来的那类"界面新、宿主旧"。
 * 28：**本地审核**（2026-10-11）。「报告审核」页下新增并列页签「本地审核」：用户选本机文件/文件夹，
 *    插件建一次性输入快照与 handoff，自动尝试创建**普通 DSH 对话**并发送固定审核指令，失败时
 *    退回「复制提示词 + 完全权限手动新建对话」的人工路径。新增三个 Host 操作
 *    （`local-audit-status` / `local-audit-start` / `local-audit-claim`，操作清单 39 → 42）与一条
 *    模型可见 Tool `crwu_audit_local_claim`。必须 +1 的理由：旧宿主没有这三个操作，
 *    新界面点下去只会 404 —— 而"能不能在本地审核里建会话"正是这一代的行为；
 *    反过来旧界面不知道这条链路，只会把用户留在报告审核里（不会误用新宿主的能力）。
 */
export const WORKBENCH_PROTOCOL = 31

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
