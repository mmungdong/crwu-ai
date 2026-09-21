import { distributionTargets, loadWorkbenchYaml } from '../plugins/dsh-crwu-workbench/src/host/config/yaml.ts'

/** 发布脚本与 Host 共用同一个 YAML 解析器，避免两个地址体系再次漂移。 */
export function distributionTargetsFromFile(configFile, tarballName) {
  return distributionTargets(loadWorkbenchYaml(configFile), tarballName)
}
