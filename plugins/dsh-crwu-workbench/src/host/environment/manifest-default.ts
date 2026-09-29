/**
 * 内置环境清单：工作台需要哪些工具、哪些服务、OSS 怎么配。
 *
 * **这里只有内置一份，不再有远程清单。** 2026-09-25 起整条只读 OSS 依赖被下掉：
 * `crwu` / `dws` / `ossutil` 三个二进制随插件发布在 `bin/<平台>/`（`make plugin-bin` 装配），
 * 服务清单与 OSS 参数在 `config/crwu-workbench.yml`，两处都不需要再从远端拉。
 *
 * 因此清单里**没有下载地址、没有安装目标、也没有 `command`** —— 那种字段的存在本身就会把
 * 「员工各自装到 `~/bin`」这条老路带回来（也正是要删掉的东西）。
 *
 * **2026-09-25 第二次改造：把四类混装的 `binaries[]` 拆开。** 旧清单里同时住着两种完全不同的东西：
 *
 * - `crwu` / `dws` / `ossutil`：**随插件发布的组件**（packaged）。它们不由 PATH 解析、不跑版本命令，
 *   只按包内绝对路径 `bin/<平台>/<文件>` 使用；
 * - `python3`：**运行时**（runtime）。旧清单把它当成一条 PATH 命令来探，于是「系统里有没有 python3」
 *   变成了环境自检的结论 —— 而本插件的技能脚本用的是 **DSH 自带 Python**，系统那一份根本不是依赖。
 *
 * 两类混在一张 `binaries[]` 里，界面就必然把它们平铺成一列「命令清单」：员工看到 `python3 未安装`
 * 会去装 Python，看到 `ossutil` 会去找安装包。现在分成 `packaged[]` 与 `runtime.python`：
 * 语义不同、检查方式不同（一个 stat 文件比字节数，一个解析 DSH 运行时），**失败文案也不同**。
 *
 * node 从 2026-09-25 起不在清单里（当时已移除，理由见 CHANGELOG）：三个自带二进制都是**原生可执行文件**
 * （Mach-O / PE），打包技能里没有任何地方调用 node，技能脚本是 Python。反过来把 node 标成必需会造成
 * 假阻塞：shell 的 PATH 里有没有 node 取决于 DSH 是**从 Finder 还是终端**启动的。
 */

/** 随插件发布的组件：只说「叫什么、干什么、要求什么版本」，没有 command / versionArgs / expect。 */
export interface PackagedToolSpec {
  name: string
  label: string
  note: string
  /**
   * 期望版本，仅用于**维护者详情**。
   *
   * 为什么不做成 `expect` 并现场校验：查版本必须执行二进制，而 `dws version` 会在二进制旁落一个
   * `.dws/` 状态目录 —— `bin/` 会整包带走，`pack:assert:strict` 会把它判成运行残留。
   * 版本一致性是**发布门禁**的事（`bin/manifest.json` 记 sourceVersion + sha256），不是每次自检的事。
   * 空串 = 不声明要求。
   */
  expectedVersion: string
}

/** DSH 自带 Python 运行时（技能脚本用它，**不用系统 Python**）。 */
export interface RuntimePythonSpec {
  required: boolean
  /** 版本约束，如 `>=3.10`；空串 = 不校验。 */
  expect: string
  note: string
  /** 必需的关键包；至少含 `openpyxl`（审核表格链路要用）。 */
  requiredPackages: string[]
}

export interface ServiceSpec {
  id: string
  label: string
  required: boolean
}

/**
 * iFinD（同花顺）SK 的声明。
 *
 * **没有 `path` 字段是刻意的**（2026-09-26 改造）：凭据不再读 `ifind-finance-data` 技能目录里的
 * `mcp_config.json`，改由插件 Host 自己保管在**插件状态目录**
 * （`<home>/.dsh/crwu-workbench/ifind-credential.json`，0600，见 `host/ifind/store.ts`）。
 * 路径由那一处算，清单只声明"它是什么、是不是必需、入口在哪" —— 把路径塞回清单等于又开了
 * 第二个事实源，而地址漂移正是这次要消灭的东西。
 */
export interface IfindSpec {
  label: string
  field: string
  placeholder: string
  /** **条件能力**：缺失只降级（`degraded`），不阻塞审核入口。 */
  required: boolean
  /** 「获取 SK」的官方入口（页面上的链接文案用；Host 不代填、不索取）。 */
  applyUrl: string
}

export interface OssSpec {
  enabled: boolean
  bucket: string
  endpoint: string
  prefix: string
  publicBaseUrl: string
  ossutil: string
  probeCommand: string
  extraArgs: string[]
  linkMode: string
  linkTtl: number
  autoUpload: boolean
}

export interface EnvManifest {
  schema: string
  /** 随插件发布的组件（按包内绝对路径使用）。 */
  packaged: PackagedToolSpec[]
  /** 运行时：DSH 自带 Python。 */
  runtime: { python: RuntimePythonSpec }
  /** ⑥ 外部数据：iFinD（同花顺）SK 的声明（凭据位置在 host/ifind/store.ts）。 */
  ifind: IfindSpec
  /**
   * 需要「登录 / 授权」的服务。
   *
   * `oss` 也在这一列里，但它**只喂 ⑤ 交付层的门禁**（`required` 的取值来源）：
   * 环境结果里的 `services` 分区只呈现氚云与钉钉这两条登录，OSS 归 `delivery`。
   */
  services: ServiceSpec[]
  oss: OssSpec
  workspace: { preferTitle: string; preferPath: string }
}

/**
 * 「DSH 自带运行时」的标准说法。
 *
 * 宿主与界面共用同一个来源口径：写「系统 Python」会让员工去装一份插件根本不会用的东西。
 */
export const DSH_RUNTIME_SOURCE = 'DSH 自带（bundled runtime）'

/**
 * 内置默认清单。
 *
 * 它是**唯一**的清单来源，所以必须自洽：组件、运行时、服务、OSS、工作空间偏好都得有可用默认值，
 * 不能出现空字段让调用方去猜。
 */
export const DEFAULT_MANIFEST: EnvManifest = {
  schema: 'crwu.env-manifest.v4',
  packaged: [
    {
      name: 'crwu',
      label: '审核编排 CLI（crwu）',
      note: '审核编排 CLI（crwu-audit 全流程）。随插件发布在 bin/<平台>/，员工机器上零安装。',
      expectedVersion: '',
    },
    {
      name: 'dws',
      label: '钉钉 CLI（dws）',
      note: '钉钉 CLI（上游 dingtalk-workspace-cli 的 vendored 二进制）。随插件发布在 bin/<平台>/，'
        + '版本要求以清单常量为准，不在自检里执行二进制去问。',
      expectedVersion: '>=0.2.14',
    },
    {
      name: 'ossutil',
      label: '阿里云 OSS 上传工具（ossutil）',
      note: '阿里云 OSS 上传。随插件发布在 bin/<平台>/，员工机器上零安装。',
      expectedVersion: '',
    },
  ],
  runtime: {
    python: {
      required: true,
      expect: '>=3.10',
      note: '审核技能脚本用的 Python 运行时与关键依赖包，由 DSH 自带（bundled runtime）提供；'
        + '本插件不使用系统 Python，也不需要员工安装或配置 PATH。',
      requiredPackages: ['openpyxl', 'python-docx', 'python-pptx', 'Pillow', 'lxml', 'numpy', 'pandas', 'XlsxWriter'],
    },
  },
  ifind: {
    label: '同花顺 iFinD（外部数据）',
    // **可选项**（2026-09-30 口径，覆盖 2026-09-26 的「必需项」）：iFinD 是外部数据源，
    // 不是基础环境的必配项。未配置时：
    // - **不阻塞**（`global` / `auditCore` 都不受影响，员工照常进报告审核）；
    // - 仍记一条 **非阻塞** issue（scope = `external-data`），只关掉 `capabilities.externalData`；
    // - 涉及外部数据的项目在审核结果里记「未检查」，而不是让整条审核跑不起来。
    // 判据仍是**真的取到一次数据**（`initialize → tools/list → tools/call`），不是"文件在、字段非空"。
    required: false,
    field: 'auth_token',
    placeholder: 'your ifind-mcp key',
    applyUrl: 'https://mcp.51ifind.com/',
  },
  services: [
    { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true },
    { id: 'dingtalk', label: '钉钉认证', required: true },
    { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true },
  ],
  oss: {
    enabled: true,
    bucket: '',
    endpoint: '',
    prefix: 'crwu/audit',
    publicBaseUrl: '',
    ossutil: 'ossutil',
    probeCommand: '',
    extraArgs: [],
    linkMode: 'signed',
    linkTtl: 3600,
    autoUpload: true,
  },
  workspace: {
    preferTitle: '中瑞世联工作空间',
    preferPath: '',
  },
}
