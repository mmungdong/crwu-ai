import type { IfindCheck, PackageIntegrityCheck, ServiceCheck } from '../../host/core/environment/probe.ts'
import type { OssCredView as HostOssCredView } from '../../host/integrations/oss/cred.ts'
import type { IfindCheckView, OssCredView, PackageIntegrityView, ServiceCheckView } from '../contracts/common.ts'

/** 环境自检零件的编译期契约（探测结果 → 线协议视图）。 */
export const PACKAGE_INTEGRITY_FROM_HOST: (check: PackageIntegrityCheck) => PackageIntegrityView = (check) => check
export const SERVICE_CHECK_FROM_HOST: (check: ServiceCheck) => ServiceCheckView = (check) => check
export const IFIND_CHECK_FROM_HOST: (check: IfindCheck) => IfindCheckView = (check) => check
export const OSS_CRED_VIEW_FROM_HOST: (view: HostOssCredView) => OssCredView = (view) => view
