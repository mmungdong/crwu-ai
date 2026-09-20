import * as React from 'react'
import { rpc } from '../../api/client.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { WORKBENCH_CLASSES } from './consts.ts'

/** 包形态迁移期间的 Host 链路自检面板。 */
export function WorkbenchPanel(): React.ReactElement {
  const [boot, setBoot] = React.useState<Record<string, unknown> | null>(null)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let alive = true
    rpc('boot')
      .then((result) => { if (alive) setBoot(result) })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { alive = false }
  }, [])

  return <div className={WORKBENCH_CLASSES.root}>
    <div className={WORKBENCH_CLASSES.title}>{zhCN.title}</div>
    <div className={WORKBENCH_CLASSES.description}>{zhCN.skeletonDescription}</div>
    {error !== '' ? <div className={WORKBENCH_CLASSES.error}>{error}</div> : null}
    {boot === null
      ? <div className={WORKBENCH_CLASSES.result}>{zhCN.loadingHost}</div>
      : <pre className={WORKBENCH_CLASSES.result}>{JSON.stringify(boot, null, 2)}</pre>}
  </div>
}
