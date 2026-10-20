import * as React from 'react'
import { SideDrawer } from '../SideDrawer.tsx'

export interface WorkflowWorkspaceSelection {
  nodeId: string
  label: string
}

export interface WorkflowWorkspaceProps {
  /** Exact registered graph identity; the workspace never assumes a business domain. */
  graphId: string
  graphVersion?: string
  summary?: React.ReactNode
  /** Plan/decision blocks stay in the main surface, never in a permanent side column. */
  decisions?: React.ReactNode
  graph: React.ReactNode
  children?: React.ReactNode
  selection: WorkflowWorkspaceSelection | null
  /** Drawer body for the active selection; a loading state until async detail arrives. */
  detail: React.ReactNode
  onClose: () => void
  returnFocusTo?: { current: { focus?: () => void } | null } | null
}

const CLOSE_ANIMATION_MS = 150

function prefersReducedMotion(): boolean {
  const media = (globalThis as {
    matchMedia?: (query: string) => { matches?: boolean }
  }).matchMedia?.('(prefers-reduced-motion: reduce)')
  return media?.matches === true
}

/**
 * Business-neutral workflow workspace.
 *
 * The graph is the full-width primary surface; plans and pending decisions sit above
 * it. Selecting a node opens the shared `SideDrawer` immediately (with loading until
 * detail arrives) instead of reserving a permanent inspector column.
 *
 * Close handling is intentionally stable: polling re-renders must not re-install the
 * drawer focus effect, otherwise every poll would steal focus back into the drawer.
 * The previous content/label survive for the 150ms exit animation; reduced motion
 * unmounts immediately.
 */
export function WorkflowWorkspace(props: WorkflowWorkspaceProps): React.ReactElement {
  const [closing, setClosing] = React.useState(false)
  const [lastSelection, setLastSelection] = React.useState<WorkflowWorkspaceSelection | null>(props.selection)
  const lastContent = React.useRef<React.ReactNode>(props.detail)
  const lastLabel = React.useRef<string>(props.selection?.label ?? '')

  // Remember the latest open content so the exit animation keeps showing it.
  if (props.selection !== null) {
    lastContent.current = props.detail
    lastLabel.current = props.selection.label
  }

  const onCloseRef = React.useRef(props.onClose)
  onCloseRef.current = props.onClose
  const close = React.useCallback(() => { onCloseRef.current() }, [])

  React.useEffect(() => {
    if (props.selection !== null) {
      setLastSelection(props.selection)
      setClosing(false)
      return
    }
    if (lastSelection === null) return
    if (prefersReducedMotion()) {
      setLastSelection(null)
      setClosing(false)
      return
    }
    setClosing(true)
    const timer = setTimeout(() => {
      setLastSelection(null)
      setClosing(false)
    }, CLOSE_ANIMATION_MS)
    return () => { clearTimeout(timer) }
  }, [props.selection?.nodeId, lastSelection?.nodeId])

  const selection = props.selection ?? lastSelection
  const title = props.selection?.label ?? lastLabel.current

  return <section
    className="crwu-workflow-workspace"
    data-workflow-workspace={props.graphId}
    data-workflow-workspace-version={props.graphVersion ?? ''}
  >
    <div className="crwu-workflow-surface">
      {props.summary}
      {props.decisions}
      {props.graph}
      {props.children}
    </div>
    {selection === null
      ? null
      : <SideDrawer
        title={title}
        subtitle={selection.nodeId}
        closing={closing}
        initialFocus="heading"
        dataAttributes={{
          'data-workflow-node-drawer': selection.nodeId,
          'data-workflow-glass': 'true',
        }}
        returnFocusTo={props.returnFocusTo}
        onClose={close}
      >
        {props.selection === null ? lastContent.current : props.detail}
      </SideDrawer>}
  </section>
}
