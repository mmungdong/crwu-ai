import type { UpdateSourceKind } from './types.ts'

/**
 * 自助更新协议里的固定值。
 *
 * 这些值属于**跨进程契约**（`update-status` / `update-check` / `update-install` / `update-cancel`
 * 的返回值与判定口径），所以集中在这里，不散落到 registry / check / 界面代码里。
 */

/** 唯一允许自助更新的包名。Host 用它构造安装 spec；Client、模型、profile 都不能提交包名。 */
export const UPDATE_PACKAGE_NAME = 'dsh-crwu-workbench'

/**
 * 单个 registry 响应正文的上限（1 MiB）。
 *
 * 上限是**读取过程中**的判据，不是读完再比大小：注册表元数据在正常包上只有几十 KB，
 * 一个"先收完再判断"的实现会先被超大响应吃满内存，而这正是不该发生的事。
 */
export const UPDATE_MAX_RESPONSE_BYTES = 1024 * 1024

/** 自动检查成功结果的有效期（6 小时）：有效期内直接复用，过期只作历史展示。 */
export const UPDATE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000

/** 自动检查失败后的最短重试间隔（10 分钟），避免网络不通时反复打上游。 */
export const UPDATE_FAILURE_BACKOFF_MS = 10 * 60 * 1000

export interface UpdateSourceDescriptor {
  readonly kind: UpdateSourceKind
  /** 固定的公开 registry 根地址（以 `/` 结尾），不含包名与任何凭据。 */
  readonly registryUrl: string
  readonly timeoutMs: number
}

/**
 * 固定的公共发现源：国内网络优先 npmmirror，官方源作后备。
 *
 * 两个地址是**常量** —— 模型、Client 与 profile 都无法提交或替换它们。
 * 企业私有源不在这里：profile 明确使用私有源时更新状态直接是 `unsupported/enterprise-registry`，
 * 插件不会绕过企业源去访问公共 registry，也不会去读可能需要认证的私有地址。
 */
export const UPDATE_SOURCES: readonly UpdateSourceDescriptor[] = [
  { kind: 'npmmirror', registryUrl: 'https://registry.npmmirror.com/', timeoutMs: 3000 },
  { kind: 'npm', registryUrl: 'https://registry.npmjs.org/', timeoutMs: 5000 },
]
