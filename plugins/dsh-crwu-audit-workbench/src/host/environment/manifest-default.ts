import { DEFAULT_INSTALL_DOC } from './install-prompt.ts'

/**
 * 单个二进制的按平台下载信息。
 *
 * `target` 里允许写 `~/bin/ossutil`：主目录由 `expandLocal` 按执行世界展开，
 * 这里不把绝对路径写死（换机器/换用户就失效）。
 */
export interface PlatformEntry {
  url: string
  sha256: string
  target?: string
  archive?: string
  member?: string
}

export interface BinarySpec {
  name: string
  command: string
  versionArgs: string[]
  /** 版本约束，如 `>=16.7`；空串 = 不校验。 */
  expect: string
  url: string
  sha256: string
  target: string
  archive: string
  member: string
  platforms: Record<string, PlatformEntry> | null
  required: boolean
  note: string
}

export interface ServiceSpec {
  id: string
  label: string
  required: boolean
}

export interface IfindKeySpec {
  required: boolean
  path: string
  field: string
  placeholder: string
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
  updatedAt: string
  installDocUrl: string
  binaries: BinarySpec[]
  ifindKey: IfindKeySpec
  services: ServiceSpec[]
  oss: OssSpec
  workspace: { preferTitle: string; preferPath: string }
}

/** ossutil 版本与两个下载源；换版本只改这三处。 */
export const OSSUTIL_VERSION = '1.7.19'
export const OSSUTIL_BASE = `https://gosspublic.alicdn.com/ossutil/${OSSUTIL_VERSION}`
export const CRWU_BASE = 'https://crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-bin'

/** crwu CLI 的预编译包：目前只有 mac arm64 与 windows x64。 */
export function crwuPlatforms(): Record<string, PlatformEntry> {
  return {
    'darwin-arm64': {
      url: `${CRWU_BASE}/mac/crwu`,
      sha256: '3ab83144f2fd6de2e40f6cac03a8cf1f9b6a0716db797126dfcd14111efc7040',
      target: '~/bin/crwu',
    },
    'win32-x64': {
      url: `${CRWU_BASE}/windows/crwu.exe`,
      sha256: '321c6775d65a5153880315800540257ae21cba346138dffbfbed2b4b5221b438',
      target: '~/bin/crwu.exe',
    },
  }
}

/** ossutil 官方包的按平台表。 */
export function ossutilPlatforms(): Record<string, PlatformEntry> {
  const version = OSSUTIL_VERSION
  const posix = '~/bin/ossutil'
  const windows = '~/bin/ossutil.exe'
  const zip = (suffix: string, sha256: string, member: string, target: string): PlatformEntry => ({
    url: `${OSSUTIL_BASE}/ossutil-v${version}-${suffix}.zip`,
    sha256,
    member,
    archive: 'zip',
    target,
  })
  return {
    'darwin-arm64': zip('mac-arm64', '10ece4d328c5d2440833adc5f4167168e9b2a4c5d364f673b0c45bcc4fd02ec5', 'ossutil', posix),
    'darwin-x64': zip('mac-amd64', '9cf82a53fe24d8b5cc3dfb441787e0ea19c24dd7a1246653d5f1a28b7923d6fe', 'ossutil', posix),
    'linux-x64': zip('linux-amd64', 'dcc512e4a893e16bbee63bc769339d8e56b21744fd83c8212a9d8baf28767343', 'ossutil', posix),
    'linux-arm64': zip('linux-arm64', 'f612c2a88d4d28363e254168d521fac5df632f2547ba84eaebacf6497dc04d57', 'ossutil', posix),
    'linux-arm': zip('linux-arm', 'ffe8b479e5fd3c0e146a14cd32e8ef5736d23f6c8de157944288ee09db2d7b1d', 'ossutil', posix),
    'linux-ia32': zip('linux-386', 'f8a4a7e1df8529b06a3f3cca194a1c99163cb3b8ab3b5d64228c207c3ae63b86', 'ossutil', posix),
    'win32-x64': zip('windows-amd64', '8e9176aedc87d230ccd97dc7236b16564f2a068609ed301acdc73dc27faf7e77', 'ossutil.exe', windows),
    'win32-ia32': zip('windows-386', '772469ef02b91e893f7211acf732c2c07cd93214552ed7cf84157d3d9b9fb799', 'ossutil.exe', windows),
  }
}

/**
 * 内置默认清单。
 *
 * 远程清单（`manifestUrl`）拿不到时回退到它 —— 所以它必须自洽：二进制、服务、OSS、
 * 工作空间偏好都得有可用默认值，不能出现空字段让调用方去猜。
 */
export const DEFAULT_MANIFEST: EnvManifest = {
  schema: 'crwu.env-manifest.v1',
  updatedAt: '',
  // 内置清单里的这一项原来留空，违反了「内置默认必须自洽」这条自己定的规则：
  // 拿不到远程清单时，安装提示词里的清单地址就是空的，agent 没有可照做的文档。
  installDocUrl: DEFAULT_INSTALL_DOC,
  binaries: [
    {
      name: 'node',
      command: 'node',
      versionArgs: ['--version'],
      expect: '>=16.7',
      url: '',
      sha256: '',
      target: '',
      archive: '',
      member: '',
      platforms: null,
      required: true,
      note: '最上游运行时：dws（npm 包）与 iFinD 的 Node 路径都依赖它',
    },
    {
      name: 'crwu',
      command: 'crwu',
      versionArgs: ['version'],
      expect: '',
      url: '',
      sha256: '',
      target: '',
      archive: '',
      member: '',
      platforms: crwuPlatforms(),
      required: true,
      note: '审核编排 CLI（crwu-audit 全流程）。mac 包为 arm64；Intel mac / Linux 暂无预编译包。',
    },
    {
      name: 'dws',
      command: 'dws',
      versionArgs: ['version'],
      expect: '>=0.2.14',
      url: '',
      sha256: '',
      target: '',
      archive: '',
      member: '',
      platforms: null,
      required: true,
      note: '钉钉 CLI（npm 包 dingtalk-workspace-cli）',
    },
    {
      name: 'python3',
      command: 'python3',
      versionArgs: ['--version'],
      expect: '>=3.8',
      url: '',
      sha256: '',
      target: '',
      archive: '',
      member: '',
      platforms: null,
      required: true,
      note: '技能自带脚本运行时',
    },
    {
      name: 'ossutil',
      command: 'ossutil',
      versionArgs: ['--version'],
      expect: '',
      url: '',
      sha256: '',
      target: '',
      archive: '',
      member: '',
      platforms: ossutilPlatforms(),
      required: true,
      note: '阿里云 OSS 上传（按平台自动选用对应包）',
    },
  ],
  ifindKey: {
    required: true,
    path: '~/.agents/skills/ifind-finance-data/mcp_config.json',
    field: 'auth_token',
    placeholder: 'your ifind-mcp key',
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
