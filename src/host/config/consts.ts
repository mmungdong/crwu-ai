/** 部署配置的稳定默认值。 */
export const CONFIG_DEFAULTS = {
  caseRoot: '',
  preferWorkspaceTitle: '中瑞世联工作空间',
  manifestUrl: '',
  installDocUrl: '',
  formName: '报告审核',
  ossBucket: '',
  ossPrefix: '',
  ossEndpoint: '',
  ossLinkMode: 'signed' as const,
  ossLinkTtlSeconds: 3600,
  autoUpload: true,
  singleAuditOnly: true,
  requireTopLevelParent: true,
}
