/**
 * Isolated real-source fixture for the shared UI controls.
 *
 * Built by `install/ui-browser-check.mjs` with an external test-only React/ReactDOM root; it is
 * not part of the product bundle. All data is local and no account/provider is touched.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Button, IconButton, FormField, TextInput, TextArea, Select, DatePicker } from '../../src/client/ui/components/index.ts'
import { Button as LegacyButton } from '../../src/client/ui/primitives.tsx'
import { WORKBENCH_STYLE_TEXT } from '../../src/client/styles/bundle.ts'

const ASSETS = [
  { value: 'real-estate', label: '房地产', hint: '住宅、商业办公等不动产' },
  { value: 'other', label: '其他资产', hint: '按知识库引导选择' },
]

function App(): React.ReactElement {
  const [date, setDate] = React.useState('2026-10-15')
  const [limit, setLimit] = React.useState('2000-10-15')
  const [other, setOther] = React.useState('')
  const [assetA, setAssetA] = React.useState('')
  const [assetB, setAssetB] = React.useState('')
  const [text, setText] = React.useState('')
  const [dark, setDark] = React.useState(false)
  React.useEffect(() => {
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }, [dark])
  return <main data-crwu-scope="workbench" className="crwu-workbench-view"
    style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box', background: 'var(--crwu-app-bg)', color: 'var(--crwu-text-primary)' }}>
    <style>{WORKBENCH_STYLE_TEXT}</style>
    <div style={{ maxWidth: 680, display: 'grid', gap: 20 }}>
      <Button data-fixture="theme" onClick={() => { setDark(!dark) }}>切换主题</Button>
      <FormField label="项目名称">{(field) => <TextInput {...field} value={text} onChange={setText} clearable />}</FormField>
      <FormField label="资产类型" required>{(field) => <Select {...field} name="asset-a" value={assetA} placeholder="请选择资产类型" options={ASSETS} onChange={setAssetA} />}</FormField>
      <FormField label="资产类型（同名）">{(field) => <Select {...field} name="asset-a" value={assetB} placeholder="请选择资产类型" options={ASSETS} onChange={setAssetB} />}</FormField>
      <FormField label="资产类型（禁用）">{(field) => <Select {...field} name="asset-disabled" value="" placeholder="不可选" options={ASSETS} disabled onChange={() => {}} />}</FormField>
      <section data-fixture="date">
        <FormField label="基准日">{(field) => <DatePicker {...field} value={date} onChange={setDate} />}</FormField>
        <output data-result="date">{date}</output>
      </section>
      <section data-fixture="limit">
        <FormField label="有限日期">{(field) => <DatePicker {...field} value={limit} min="2000-01-01" max="2000-12-31" onChange={setLimit} />}</FormField>
        <output data-result="limit">{limit}</output>
      </section>
      <section data-fixture="other">
        <FormField label="空日期">{(field) => <DatePicker {...field} value={other} onChange={setOther} />}</FormField>
      </section>
      <FormField label="补充说明">{(field) => <TextArea {...field} value={text} onChange={setText} />}</FormField>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button data-fixture="primary">开始估值</Button>
        <Button variant="secondary">选择文件</Button>
        <Button variant="soft">查看能力</Button>
        <Button variant="text">取消</Button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['primary', 'secondary', 'soft', 'text'] as const).map((variant) =>
          <IconButton key={variant} variant={variant} label={variant}>+</IconButton>)}
        <LegacyButton tone="warn" label="重新审核" />
        <LegacyButton label="普通操作" />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button data-fixture-loading="off">处理中</Button>
        <Button data-fixture-loading="on" loading>处理中</Button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled>禁用</Button>
      </div>
    </div>
  </main>
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
