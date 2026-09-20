return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    const layout = ctx.get('layout')
    const wbCache = {
      boot: null, env: null, envAt: 0, installPrompt: null, parentSessionId: '', parentIssue: '',
      ossLoaded: false, ossIndex: {}, auditInfo: {}, auditInfoRequest: 0,
    }
    // 案例根目录与「当前会话属于哪个工作空间」由 Host 解析（只有 Host 能读
    // workspaceRegistry / sessions）。绑定父会话的组件拿到结果后广播，
    // 工作台不必为了这几个字段再自检一次。
    const wbListeners = []
    function wbNotify() {
      for (let i = 0; i < wbListeners.length; i += 1) {
        try { wbListeners[i]() } catch (error) { /* 监听者已卸载 */ }
      }
    }
    function wbAdopt(result) {
      if (!result) return
      if (result.workspace) wbCache.workspace = result.workspace
      if (result.sessionWorkspace) wbCache.sessionWorkspace = result.sessionWorkspace
      // 审核父级是 Host 的权威事实：bind-session 会拒绝把子代理登记成父级
      // （审核只挂一层），所以这里以 Host 回传的 parentSessionId 为准并显示出来。
      if (typeof result.parentSessionId === 'string') wbCache.parentSessionId = result.parentSessionId
      wbCache.parentIssue = result.ok === false && result.subagent === true ? String(result.error || '') : ''
      wbNotify()
    }

    styles.insert([
      '.wb-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.wb-head{padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.wb-title{font-size:16px;font-weight:600;letter-spacing:.3px}',
      '.wb-sub{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wb-mods{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px;align-items:center}',
      '.wb-mod{padding:5px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;font-family:inherit}',
      '.wb-mod-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);font-weight:600}',
      '.wb-lockhint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px}',
      '.wb-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 28px}',
      '.wb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.wb-input,.wb-textarea{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;color:var(--dsw-alias-label-primary);padding:6px 9px;font-size:12px;font-family:inherit}',
      '.wb-input:focus,.wb-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.wb-textarea{width:100%;min-height:150px;line-height:1.6;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.wb-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.wb-btn:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.wb-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.wb-btn-p{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}',
      '.wb-btn-w{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.wb-btn-s{padding:3px 9px;font-size:11px}',
      '.wb-btn-lg{padding:8px 16px;font-size:13px}',
      '.wb-split{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:14px;align-items:start}',
      '.wb-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 13px;margin-bottom:10px}',
      '.wb-card-t{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.4px;margin-bottom:9px;display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.wb-nums{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px}',
      '.wb-num{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.wb-num-v{font-size:19px;font-weight:700;line-height:1.1}',
      '.wb-num-k{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}',
      '.wb-chip{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:11px;margin:0 4px 4px 0;color:var(--dsw-alias-label-secondary)}',
      '.wb-chip-a{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.wb-tb{width:100%;border-collapse:collapse;font-size:12px}',
      '.wb-tb th{text-align:left;padding:7px 8px;color:var(--dsw-alias-label-secondary);font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.wb-tb td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}',
      '.wb-tb tr:hover td{background:var(--dsw-alias-bg-layer-2)}',
      '.wb-badge{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:600;white-space:nowrap}',
      '.wb-high{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}',
      '.wb-medium{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent)}',
      '.wb-low{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.wb-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}',
      '.wb-list{list-style:none;margin:0;padding:0}',
      '.wb-li{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.wb-li-sel{border-color:var(--dsw-alias-brand-primary)}',
      '.wb-click{cursor:pointer}',
      '.wb-muted{color:var(--dsw-alias-label-secondary)}',
      '.wb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.wb-notice{border-radius:8px;padding:9px 11px;margin-bottom:11px;font-size:12px;line-height:1.6;border:1px solid}',
      '.wb-notice-e{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
      '.wb-notice-w{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}',
      '.wb-notice-i{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.wb-notice-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}',
      '.wb-empty{padding:26px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.wb-ev{border-left:2px solid var(--dsw-alias-border-l2);padding:6px 0 6px 10px;margin:7px 0;font-size:12px;line-height:1.65}',
      '.wb-ev-t{font-weight:600}',
      '.wb-quote{background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:6px 8px;margin-top:4px;white-space:pre-wrap}',
      '.wb-pre{background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px;margin-top:6px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.wb-sec{margin-top:9px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.wb-prog{display:flex;flex-wrap:wrap;gap:6px}',
      '.wb-prog-i{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.wb-prog-y{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.wb-img{max-width:100%;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);margin-top:7px}',
      '.wb-flexline{display:flex;justify-content:space-between;gap:10px;align-items:baseline}',
      '.wb-form{display:grid;grid-template-columns:110px 1fr;gap:8px 10px;align-items:center;margin-top:4px}',
      '.wb-form-l{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wb-form input{width:100%}',
      '.wb-page-tabs{display:flex;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px}',
      '.wb-page-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 1px 10px;cursor:pointer;font:inherit;font-weight:600;border-bottom:2px solid transparent}',
      '.wb-page-tab-on{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
      '.wb-page-count{display:inline-block;min-width:18px;padding:1px 6px;margin-left:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10px;text-align:center}',
      '.wb-review-main{font-weight:600}',
      '.wb-drawer-shade{position:absolute;inset:0;background:rgba(0,0,0,.22);z-index:20}',
      '.wb-drawer{position:absolute;z-index:21;top:0;right:0;width:min(430px,100%);height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);box-shadow:-12px 0 32px rgba(0,0,0,.12);padding:18px}',
      '.wb-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.wb-drawer-title{font-size:16px;font-weight:700}',
      '.wb-drawer-section{padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.wb-drawer-section:last-child{border-bottom:0}',
      '.wb-kv{display:grid;grid-template-columns:105px 1fr;gap:7px 10px;line-height:1.55}',
      '.wb-kv-k{color:var(--dsw-alias-label-secondary)}',
    ].join('\n'))

    function call(method, args) { return host.call(method, args === undefined ? null : args) }

    function errText(error) { return String(error && error.message ? error.message : error) }

    // 审核记录里的时间是 ISO（UTC），行内显示成本机时间，方便区分同一条报告的多次重启。
    function fmtTime(iso) {
      const t = Date.parse(String(iso || ''))
      if (!isFinite(t)) return String(iso || '')
      const d = new Date(t)
      const p = function (n) { return (n < 10 ? '0' : '') + n }
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    function copyText(value, done) {
      let ok = false
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : undefined
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          nav.clipboard.writeText(value)
          ok = true
        } else {
          const doc = typeof document !== 'undefined' ? document : undefined
          if (doc) {
            const node = doc.createElement('textarea')
            node.value = value
            node.setAttribute('readonly', 'readonly')
            doc.body.appendChild(node)
            node.select()
            ok = doc.execCommand('copy') === true
            doc.body.removeChild(node)
          }
        }
      } catch (error) { ok = false }
      if (ok) { done(true, ''); return }
      call('workbench:clipboard', { text: value }).then(function (r) {
        done(!!(r && r.ok), String((r && r.error) || ''))
      }).catch(function (e) { done(false, errText(e)) })
    }

    function Chip(props) {
      return React.createElement('span', { className: 'wb-chip' + (props.accent ? ' wb-chip-a' : '') + (props.mono ? ' wb-mono' : '') }, props.text)
    }

    function Card(props) {
      return React.createElement('div', { className: 'wb-card' },
        props.title ? React.createElement('div', { className: 'wb-card-t' },
          React.createElement('span', null, props.title),
          props.extra || null,
        ) : null,
        props.children,
      )
    }

    function Handoff(props) {
      const [copied, setCopied] = React.useState('')
      const prompt = props.prompt
      return React.createElement(Card, { title: '手动发起（固定回退）' },
        React.createElement('div', { className: 'wb-notice wb-notice-i' },
          '自动创建审核子会话未成功（原因见上方提示）。你仍可以把下面这段直接发到对话里，由 crwu-audit 技能执行两阶段审核。',
        ),
        React.createElement('textarea', { className: 'wb-textarea', readOnly: true, value: prompt }),
        React.createElement('div', { className: 'wb-row', style: { marginTop: '9px' } },
          React.createElement('button', {
            className: 'wb-btn wb-btn-p', type: 'button',
            onClick: function () { copyText(prompt, function (ok, why) { setCopied(ok ? '已复制到剪贴板' : ('自动复制不可用' + (why ? '：' + why : '') + '，请在文本框内全选复制')) }) },
          }, '复制指令'),
          React.createElement('button', {
            className: 'wb-btn', type: 'button',
            onClick: function () { if (layout) layout.selectPanel('conversation') },
          }, '跳到对话'),
          copied ? React.createElement('span', { className: 'wb-muted' }, copied) : null,
        ),
      )
    }

    function binStatusBadge(check) {
      if (check.ok) return React.createElement('span', { className: 'wb-badge wb-ok' }, '就绪')
      if (!check.found) return React.createElement('span', { className: 'wb-badge wb-high' }, '未安装')
      return React.createElement('span', { className: 'wb-badge wb-medium' }, '版本不符')
    }

    function TrustToggle(props) {
      const on = props.trust && props.trust.h3yun === true
      return React.createElement('label', { className: 'wb-row', style: { gap: '6px', cursor: 'pointer' } },
        React.createElement('input', {
          type: 'checkbox', checked: on,
          onChange: function (e) { props.setTrust(e.target.checked) },
        }),
        React.createElement('span', null, '本次运行记住氚云授权（不再逐次询问）'),
        on ? React.createElement('span', { className: 'wb-badge wb-medium' }, '已开启') : null,
      )
    }

    function WorkspaceCard(props) {
      const ws = props.workspace
      const sw = props.sessionWorkspace
      const chosen = !!(ws && ws.chosen)
      const src = (ws && ws.source) || ''
      const srcLabel = src === 'saved' ? '上次选择'
        : (src === 'manifest-workspace' ? '清单指定' : (src === 'manual' ? '手动选择' : ''))
      const wsPath = (ws && ws.path) || ''
      const sessionCwd = (sw && sw.sessionCwd) || ''
      // 子会话的 cwd 只能继承父会话，API 没有覆盖入口；所以父会话开在哪个
      // 工作空间，审核子会话就落在哪个工作空间的 cwd 上。这里只做提示，
      // 不改选根 —— 本机父会话属于 crwu-ai 工作空间（源码仓库）。
      const mismatch = !!(chosen && sessionCwd && wsPath && sessionCwd !== wsPath)
      const sessionLabel = (sw && sw.workspaceTitle) || sessionCwd
      return React.createElement(Card, {
        title: '① 中瑞世联工作空间（案例根目录 / 前置条件）',
        extra: chosen
          ? React.createElement('span', { className: 'wb-badge wb-ok' }, '已选定' + (srcLabel ? ' · ' + srcLabel : ''))
          : React.createElement('span', { className: 'wb-badge wb-high' }, '未选定'),
      },
        chosen ? React.createElement('div', null,
          React.createElement('div', { className: 'wb-mono', style: { marginBottom: '4px', wordBreak: 'break-all', fontWeight: 600 } }, wsPath),
          React.createElement('div', { className: 'wb-muted', style: { marginBottom: '8px', lineHeight: 1.6 } },
            '审核产物写到 ' + wsPath + '/<报告流水号>/。子会话的 cwd 只能继承父会话（DSH 的 subagent API 没有 cwd 覆盖入口），所以插件把案例目录作为绝对路径写进审核指令，由 crwu 按它落盘。'
          ),
          React.createElement('div', { className: 'wb-row' },
            React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: props.busy, onClick: function () { props.pick() } }, '更换工作空间'),
            React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: props.busy, onClick: function () { props.open() } }, '在新会话中打开'),
            src === 'manual'
              ? React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: props.busy, onClick: function () { props.auto() } }, '恢复自动识别')
              : null,
          ),
        ) : React.createElement('div', null,
          React.createElement('div', { className: 'wb-notice wb-notice-w' },
            '没找到清单指定的工作空间，也没有上次的选择，请先选定一个目录。'
          ),
          React.createElement('div', { className: 'wb-row' },
            React.createElement('button', { className: 'wb-btn wb-btn-p', type: 'button', disabled: props.busy, onClick: function () { props.pick() } }, '选择目录作为工作空间'),
            React.createElement('button', { className: 'wb-btn', type: 'button', disabled: props.busy, onClick: function () { props.create() } }, '新建目录并用作工作空间'),
          ),
        ),
        mismatch ? React.createElement('div', { className: 'wb-notice wb-notice-w', style: { marginTop: '9px' } },
          React.createElement('div', null,
            '注意：当前这个会话属于工作空间「' + sessionLabel + '」（cwd ' + sessionCwd + '），和上面选的案例根目录不是同一个。'
          ),
          React.createElement('div', { style: { marginTop: '5px' } },
            '审核产物会按绝对路径写到案例根目录，但审核子会话本身的 cwd 仍然是 ' + sessionCwd + '。要让两者一致，请在案例根目录的会话里打开工作台。'
          ),
          React.createElement('div', { style: { marginTop: '8px' } },
            React.createElement('button', {
              className: 'wb-btn wb-btn-w wb-btn-s', type: 'button', disabled: props.busy,
              onClick: function () { props.open() },
            }, '在「' + ((ws && ws.title) || wsPath) + '」的会话中打开工作台'),
          ),
        ) : null,
        props.msg ? React.createElement('div', { className: 'wb-notice wb-notice-i', style: { marginTop: '9px' } }, props.msg) : null,
      )
    }

    function IfindCard(props) {
      const state = props.state
      const env = state.env
      const ik = (env && env.ifindKey) || null
      if (!ik) return null
      return React.createElement(Card, {
        title: '④ iFinD 密钥（必需）',
        extra: ik.ok
          ? React.createElement('span', { className: 'wb-badge wb-ok' }, '已配置')
          : React.createElement('span', { className: 'wb-badge wb-high' }, '未配置'),
      },
        React.createElement('div', { className: 'wb-mono', style: { wordBreak: 'break-all' } }, ik.path || ''),
        ik.ok
          ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '6px' } }, 'auth_token 已配置（长度 ' + String(ik.tokenLength || 0) + '，不回显）')
          : React.createElement('div', { className: 'wb-notice wb-notice-w', style: { marginTop: '7px' } },
              (ik.reason || '未配置') + '。密钥来源：https://mcp.51ifind.com → 个人中心 → 密钥管理。详细安装步骤见安装清单。'
            ),
      )
    }

    function OssAuthCard(props) {
      const state = props.state
      const cred = state.ossCred || null
      const [akId, setAkId] = React.useState('')
      const [akSecret, setAkSecret] = React.useState('')
      const [sts, setSts] = React.useState('')
      const [endpoint, setEndpoint] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const defaultEndpoint = (state.env && state.env.oss && state.env.oss.endpoint) || ''

      function save() {
        if (!akId.trim() || !akSecret.trim()) { setMsg('AccessKey ID 与 AccessKey Secret 都必须填。'); return }
        setBusy(true)
        setMsg('')
        call('workbench:oss-cred-save', {
          accessKeyId: akId.trim(), accessKeySecret: akSecret.trim(),
          stsToken: sts.trim(), endpoint: (endpoint.trim() || defaultEndpoint),
        }).then(function (r) {
          setBusy(false)
          if (!r || !r.ok) { setMsg('保存失败：' + String((r && r.error) || '未知原因')); return }
          setAkSecret('')
          setSts('')
          setMsg(r.probe && r.probe.ok ? ('已写入 ' + r.path + '（权限 600），并用它实测通过：' + r.probe.state) : ('已写入 ' + r.path + '（权限 600），但实测未通过：' + String((r.probe && r.probe.detail) || '').slice(0, 300)))
          props.refreshEnv()
        }).catch(function (e) { setBusy(false); setMsg('保存失败：' + errText(e)) })
      }

      return React.createElement(Card, {
        title: '⑥ OSS 授权（AccessKey）',
        extra: cred && cred.exists
          ? React.createElement('span', { className: 'wb-badge wb-ok' }, '已写入配置文件')
          : React.createElement('span', { className: 'wb-badge wb-high' }, '未配置'),
      },
        React.createElement('div', { className: 'wb-muted', style: { lineHeight: 1.65, marginBottom: '9px' } },
          '凭据直接写入 ossutil 自己的配置文件 ' + ((cred && cred.path) || '~/.ossutilconfig') + '，权限 600。插件不会把密钥回显给页面，也不写日志；页面只展示掩码后的 AK ID。审核完成后会自动用这套 AK 把交付件推到 OSS。'
        ),
        cred && cred.exists ? React.createElement('div', { className: 'wb-sec', style: { marginTop: '0', marginBottom: '9px' } },
          React.createElement(Chip, { text: 'AK ID · ' + (cred.accessKeyIdMasked || '（空）'), mono: true }),
          React.createElement(Chip, { text: 'Secret · ' + (cred.hasSecret ? '已配置' : '缺失'), mono: true, accent: cred.hasSecret }),
          cred.hasSts ? React.createElement(Chip, { text: 'STS Token · 已配置', mono: true }) : null,
          React.createElement(Chip, { text: 'endpoint · ' + (cred.endpoint || '未设'), mono: true }),
        ) : null,
        React.createElement('div', { className: 'wb-form' },
          React.createElement('span', { className: 'wb-form-l' }, 'AccessKey ID'),
          React.createElement('input', { className: 'wb-input wb-mono', type: 'text', value: akId, placeholder: 'LTAI...', onChange: function (e) { setAkId(e.target.value) } }),
          React.createElement('span', { className: 'wb-form-l' }, 'AccessKey Secret'),
          React.createElement('input', { className: 'wb-input wb-mono', type: 'password', value: akSecret, placeholder: '只在提交时上传，不回显', onChange: function (e) { setAkSecret(e.target.value) } }),
          React.createElement('span', { className: 'wb-form-l' }, 'STS Token（选填）'),
          React.createElement('input', { className: 'wb-input wb-mono', type: 'password', value: sts, placeholder: '临时凭据才需要', onChange: function (e) { setSts(e.target.value) } }),
          React.createElement('span', { className: 'wb-form-l' }, 'endpoint'),
          React.createElement('input', { className: 'wb-input wb-mono', type: 'text', value: endpoint, placeholder: defaultEndpoint || 'oss-cn-beijing.aliyuncs.com', onChange: function (e) { setEndpoint(e.target.value) } }),
        ),
        React.createElement('div', { className: 'wb-row', style: { marginTop: '10px' } },
          React.createElement('button', { className: 'wb-btn wb-btn-p', type: 'button', disabled: busy, onClick: save }, busy ? '保存并实测…' : '保存并实测'),
          React.createElement('button', { className: 'wb-btn', type: 'button', disabled: state.envBusy === 'refresh', onClick: function () { props.refreshEnv() } }, '重新自检'),
        ),
        msg ? React.createElement('div', { className: 'wb-notice wb-notice-i', style: { marginTop: '9px' } }, msg) : null,
      )
    }

    function InstallPromptBlock(props) {
      const state = props.state
      const p = state.installPrompt
      return React.createElement(Card, {
        title: '⑤ 安装提示词（指向安装清单，复制后发给 Agent）',
        extra: p && p.url
          ? React.createElement('span', { className: 'wb-muted wb-mono' }, p.url.replace(/^https?:\/\//, ''))
          : null,
      },
        React.createElement('div', { className: 'wb-muted', style: { lineHeight: 1.65, marginBottom: '9px' } },
          '这里不嵌入安装文档正文 —— 复制的是一段“去读清单并按步骤执行”的指令。清单本身托管在 OSS，改内容不用改插件。'
        ),
        !p
          ? React.createElement('div', { className: 'wb-empty' }, '正在生成…')
          : React.createElement('div', null,
              React.createElement('textarea', { className: 'wb-textarea', readOnly: true, value: p.prompt }),
              React.createElement('div', { className: 'wb-row', style: { marginTop: '9px' } },
                React.createElement('button', {
                  className: 'wb-btn wb-btn-p', type: 'button',
                  onClick: function () { props.setInstallMsg('复制中…'); copyText(p.prompt, function (ok, why) { props.setInstallMsg(ok ? '安装提示词已复制，粘贴到对话里发给 Agent 即可。' : ('自动复制不可用' + (why ? '：' + why : '') + '，请在文本框内全选复制')) }) },
                }, '复制提示词'),
                React.createElement('button', {
                  className: 'wb-btn', type: 'button',
                  onClick: function () { props.refreshPrompt() },
                }, '重新生成'),
                state.installMsg ? React.createElement('span', { className: 'wb-muted' }, state.installMsg) : null,
              ),
              React.createElement('div', { className: 'wb-muted', style: { marginTop: '8px', lineHeight: 1.6, fontSize: '11px' } },
                'Agent 会去读 ' + (p.url || '') + '。该对象必须可公开读取，否则 Agent 会拿到 403。'
              ),
            ),
      )
    }

    function EnvPane(props) {
      const state = props.state
      const env = state.env
      if (!env) return React.createElement('div', { className: 'wb-empty' }, '正在自检环境…')
      const checks = env.checks || []
      const services = env.services || []
      const blocked = env.blocked || []
      const missing = checks.filter(function (c) { return !c.ok })
      const missingText = missing.length === 0 ? '无' : missing.map(function (c) { return c.name }).join('、')
      const checkedAt = state.envAt ? new Date(state.envAt).toLocaleTimeString() : ''
      return React.createElement('div', null,
        React.createElement(WorkspaceCard, {
          workspace: state.workspace,
          sessionWorkspace: state.sessionWorkspace,
          busy: state.wsBusy,
          pick: props.pickWorkspace,
          create: props.createWorkspace,
          open: props.openWorkspaceSession,
          auto: props.autoWorkspace,
          msg: state.wsMsg,
        }),
        blocked.length === 0
          ? React.createElement('div', { className: 'wb-notice wb-notice-ok' }, '环境就绪：工作空间、二进制、氚云、钉钉、iFinD、OSS 全部通过。')
          : React.createElement('div', { className: 'wb-notice wb-notice-e' },
              '环境未就绪，已隐藏后续页面。未通过：' + blocked.join('、') + '。复制下方安装提示词交给 Agent，或修好后点「重新自检」。'),
        React.createElement(Card, {
          title: '② 环境清单（远程，本地不留数据）',
          extra: React.createElement('span', { className: 'wb-muted' },
            (checkedAt ? ('上次自检 ' + checkedAt + ' · ') : '') +
            (env.manifestLoaded ? ('清单已加载 · ' + (env.manifestKind === 'url' ? '远程' : '本地')) : '清单未加载')),
        },
          React.createElement('div', { className: 'wb-row' },
            React.createElement('input', {
              className: 'wb-input wb-mono', style: { flex: '1 1 300px' }, value: state.manifestSource,
              placeholder: 'https://<bucket>.<endpoint>/crwu-env-manifest.json',
              onChange: function (e) { props.setManifestSource(e.target.value) },
            }),
            React.createElement('button', {
              className: 'wb-btn wb-btn-p', type: 'button', disabled: state.envBusy === 'refresh',
              onClick: function () { props.refreshEnv() },
            }, state.envBusy === 'refresh' ? '自检中…' : '重新自检'),
          ),
          React.createElement('div', { className: 'wb-muted', style: { marginTop: '7px', lineHeight: 1.6 } },
            '自检只在你点按钮、或刚改过工作空间/OSS 授权时重跑 —— 切面板来回看不会重复探测。'
          ),
          env.platform ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '6px' } }, '已识别平台：' + env.platform) : null,
          env.manifestError ? React.createElement('div', { className: 'wb-notice wb-notice-w', style: { marginTop: '9px' } }, env.manifestError) : null,
        ),
        React.createElement(Card, { title: '③ 二进制依赖' },
          checks.length === 0 ? React.createElement('div', { className: 'wb-empty' }, '清单没有声明二进制项。')
            : React.createElement('table', { className: 'wb-tb' },
                React.createElement('thead', null, React.createElement('tr', null,
                  React.createElement('th', null, '名称'),
                  React.createElement('th', null, '状态'),
                  React.createElement('th', null, '实际版本'),
                  React.createElement('th', null, '期望'),
                  React.createElement('th', null, '路径'),
                )),
                React.createElement('tbody', null, checks.map((check, i) => React.createElement('tr', { key: i },
                  React.createElement('td', null,
                    React.createElement('div', { style: { fontWeight: 600 } }, check.name + (check.required ? '' : '（非必需）')),
                    check.note ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '2px' } }, check.note) : null,
                    check.reason ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '2px' } }, check.reason) : null,
                  ),
                  React.createElement('td', null, binStatusBadge(check)),
                  React.createElement('td', { className: 'wb-mono' }, check.actual || '—'),
                  React.createElement('td', { className: 'wb-mono' }, check.expect || '不限'),
                  React.createElement('td', { className: 'wb-mono' }, check.path || '（未找到）'),
                ))),
              ),
          React.createElement('div', { className: 'wb-muted', style: { marginTop: '9px' } },
            '缺 ' + String(missing.length) + ' 项：' + missingText + '。安装不在工作台里做 —— 复制下方提示词，交给 Agent 执行。技能（crwu-* / dingtalk-* / iFinD）也在安装清单里一并处理。'
          ),
        ),
        React.createElement(IfindCard, { state: state }),
        React.createElement(InstallPromptBlock, {
          state: state,
          refreshPrompt: props.refreshPrompt,
          setInstallMsg: props.setInstallMsg,
        }),
        React.createElement(Card, { title: '认证与云服务' },
          services.map((svc, i) => React.createElement('div', { className: 'wb-li', key: i },
            React.createElement('div', { className: 'wb-flexline' },
              React.createElement('div', null,
                React.createElement('span', { style: { fontWeight: 600 } }, svc.label),
                ' ',
                React.createElement('span', { className: 'wb-badge ' + (svc.ok ? 'wb-ok' : 'wb-high') }, svc.state),
              ),
              svc.id === 'h3yun'
                ? React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: state.reloginBusy, onClick: function () { props.h3yunLogin() } }, state.reloginBusy ? '等待扫码…' : '打开浏览器重新扫码')
                : (svc.id === 'dingtalk'
                    ? React.createElement('div', { className: 'wb-row' },
                        React.createElement('button', { className: 'wb-btn wb-btn-p wb-btn-s', type: 'button', disabled: state.dwsBusy, onClick: function () { props.dwsLogin(false) } }, state.dwsBusy ? '等待授权…' : '浏览器扫码登录'),
                        React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: state.dwsBusy, onClick: function () { props.dwsLogin(true) } }, '设备流登录'),
                      )
                    : null),
            ),
            svc.detail ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '5px', wordBreak: 'break-all' } }, svc.detail) : null,
          )),
          React.createElement('div', { className: 'wb-sec' },
            React.createElement(TrustToggle, { trust: state.trust, setTrust: props.setTrust }),
            React.createElement('div', { className: 'wb-muted', style: { marginTop: '6px', lineHeight: 1.6 } },
              '氚云令牌寿命短于 CLI 的 36h 续期阈值，每次氚云读取都会先续期、而续期必须写系统钥匙串。这个开关只管工作台自己的 crwu 子进程；子会话的策略在创建时就冻结了。'
            ),
          ),
        ),
        React.createElement(OssAuthCard, { state: state, refreshEnv: props.refreshEnv }),
        React.createElement(Card, { title: '运行时' },
          React.createElement('div', null,
            React.createElement(Chip, { text: '案例根目录 · ' + ((state.workspace && state.workspace.path) || '（未定）'), mono: true }),
            state.sessionWorkspace && state.sessionWorkspace.sessionCwd
              ? React.createElement(Chip, { text: '本会话工作空间 · ' + (state.sessionWorkspace.workspaceTitle || state.sessionWorkspace.sessionCwd), mono: true })
              : null,
            React.createElement(Chip, { text: '会话工作区 · ' + (state.sessionRoot || '（未定）'), mono: true }),
            React.createElement(Chip, { text: 'HOME · ' + (env.home || '（未取到）'), mono: true }),
            React.createElement(Chip, { text: '平台 · ' + (env.platform || '未识别'), mono: true }),
            React.createElement(Chip, { text: 'crwu · ' + (state.crwuVersion || '未探测'), mono: true }),
            React.createElement(Chip, { text: '云端链接 · ' + (state.linkMode === 'public' ? '公有链接' : ('签名 ' + String(state.linkTtl || 3600) + 's')), mono: true }),
          ),
        ),
      )
    }

    // HTML 仍沿用现有 OSS 位置。列表阶段只持有 Key，用户点击后才签名打开。
    function CloudButtons(props) {
      const cloud = props.cloud
      if (!cloud || !cloud.htmlKey) return null
      return React.createElement('div', { className: 'wb-row', style: { marginTop: '5px' } },
        React.createElement('button', {
          className: 'wb-btn wb-btn-p wb-btn-s', type: 'button', disabled: props.busy,
          onClick: function () { props.openCloud(cloud.htmlKey) },
        }, props.busy ? '打开中…' : '查看报告'),
      )
    }

    function AuditInfoButton(props) {
      const cloud = props.cloud
      if (!cloud || !cloud.htmlKey || !cloud.jsonKey) return null
      return React.createElement('button', {
        className: 'wb-btn wb-btn-s', type: 'button',
        onClick: function () { props.openAuditInfo(props.task || null, cloud) },
      }, '审核信息')
    }

    function AuditInfoDrawer(props) {
      const state = props.state
      if (!state) return null
      const info = state.info
      const task = state.task || {}
      const summary = info && info.summary ? info.summary : {}
      const counts = summary.counts || {}
      const comparison = info && info.reviewComparison ? info.reviewComparison : {}
      const metrics = comparison.metrics || {}
      const files = comparison.reviewFiles || []
      const auditAt = info ? Date.parse(String(info.auditTime || '')) : NaN
      const modifiedAt = Date.parse(String(task.modifiedAt || ''))
      // ModifiedTime 只能说明氚云记录后来更新过，不能据此声称报告材料发生变化。
      const changedAfterAudit = isFinite(auditAt) && isFinite(modifiedAt) && modifiedAt > auditAt
      const decision = summary.decision === 'pass' ? '通过'
        : (summary.decision === 'fail' ? '需修改' : (summary.decision || '未给出'))
      return React.createElement(React.Fragment || 'div', null,
        React.createElement('div', { className: 'wb-drawer-shade', onClick: props.close }),
        React.createElement('aside', { className: 'wb-drawer' },
          React.createElement('div', { className: 'wb-drawer-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 'wb-drawer-title' }, 'AI 审核信息'),
              React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '4px' } },
                (info && info.projectId) || task.seqNo || state.seqNo || '—'),
            ),
            React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', onClick: props.close }, '关闭'),
          ),
          state.loading ? React.createElement('div', { className: 'wb-empty' }, '正在读取该项目的审核结果 JSON…') : null,
          state.error ? React.createElement('div', { className: 'wb-notice wb-notice-e', style: { marginTop: '12px' } }, state.error) : null,
          info ? React.createElement('div', null,
            React.createElement('div', { className: 'wb-drawer-section' },
              React.createElement('div', { className: 'wb-kv' },
                React.createElement('div', { className: 'wb-kv-k' }, '审核结论'), React.createElement('div', null, decision),
                React.createElement('div', { className: 'wb-kv-k' }, '审核时间'), React.createElement('div', { className: 'wb-mono' }, info.auditTime || '—'),
                React.createElement('div', { className: 'wb-kv-k' }, 'AI 审核阶段'), React.createElement('div', null, info.stage || '—'),
                React.createElement('div', { className: 'wb-kv-k' }, '当前人工复核'), React.createElement('div', null,
                  [task.reviewLevel, task.reviewState].filter(Boolean).join(' · ') || '当前页未取得'),
                React.createElement('div', { className: 'wb-kv-k' }, '当前节点'), React.createElement('div', null, task.currentNode || '—'),
              ),
              changedAfterAudit ? React.createElement('div', { className: 'wb-notice wb-notice-w', style: { marginTop: '11px', marginBottom: 0 } },
                '氚云记录在本次 AI 审核后更新过。这里只提示记录时间变化，不能据此判断报告材料已经变化。') : null,
            ),
            React.createElement('div', { className: 'wb-drawer-section' },
              React.createElement('div', { className: 'wb-card-t' }, '问题摘要'),
              React.createElement('div', { className: 'wb-row' },
                React.createElement(Chip, { text: '高风险 ' + String(counts.high === undefined ? 0 : counts.high) }),
                React.createElement(Chip, { text: '中风险 ' + String(counts.medium === undefined ? 0 : counts.medium) }),
                React.createElement(Chip, { text: '低风险 ' + String(counts.low === undefined ? 0 : counts.low) }),
                React.createElement(Chip, { text: '待确认 ' + String(counts.pendingConfirmation === undefined ? 0 : counts.pendingConfirmation) }),
              ),
              summary.narrative ? React.createElement('div', { className: 'wb-quote' }, summary.narrative) : null,
            ),
            React.createElement('div', { className: 'wb-drawer-section' },
              React.createElement('div', { className: 'wb-card-t' }, '人工复核对照'),
              React.createElement('div', { className: 'wb-kv' },
                React.createElement('div', { className: 'wb-kv-k' }, '对照状态'), React.createElement('div', null, comparison.status || '未执行'),
                React.createElement('div', { className: 'wb-kv-k' }, '命中率'), React.createElement('div', null,
                  metrics.hitRate !== undefined ? String(metrics.hitRate) + (typeof metrics.hitRate === 'number' ? '%' : '') : '—'),
                React.createElement('div', { className: 'wb-kv-k' }, '精确 / 部分 / 未命中'), React.createElement('div', null,
                  [metrics.exactHits, metrics.partialHits, metrics.misses].map(function (v) { return v === undefined ? '—' : String(v) }).join(' / ')),
              ),
              files.length > 0 ? React.createElement('div', { style: { marginTop: '10px' } }, files.map(function (file, index) {
                return React.createElement('div', { className: 'wb-ev', key: index },
                  React.createElement('div', { className: 'wb-ev-t' }, file.level || '复核文件'),
                  React.createElement('div', { className: 'wb-muted' }, file.displayName || '—'),
                  file.version ? React.createElement('div', { className: 'wb-muted' }, file.version) : null,
                )
              })) : null,
            ),
          ) : null,
        ),
      )
    }

    // 「重新审核」会把同一条报告已有的审核结果作废重跑，所以它要二次确认；
    // 首次「AI 审核」直接开始。确认态就地展开成「确认重新审核 / 取消」两个按钮，
    // 不弹窗 —— 这一行本身就是上下文。
    function StartButton(props) {
      const busy = props.state.auditBusy === props.taskKey
      const blocked = !props.state.canDispatch || !!props.state.busy || !!props.state.auditBusy || !props.state.canStart
      const [confirming, setConfirming] = React.useState(false)
      const needsConfirm = props.confirm === true

      if (needsConfirm && confirming) {
        return React.createElement('span', { className: 'wb-row', style: { gap: '4px' } },
          React.createElement('button', {
            className: 'wb-btn wb-btn-w wb-btn-s', type: 'button', disabled: blocked,
            onClick: function () { setConfirming(false); props.start(props.task, { retry: true }) },
          }, busy ? '创建中…' : '确认重新审核'),
          React.createElement('button', {
            className: 'wb-btn wb-btn-s', type: 'button',
            onClick: function () { setConfirming(false) },
          }, '取消'),
        )
      }

      return React.createElement('button', {
        className: 'wb-btn wb-btn-p wb-btn-s', type: 'button', disabled: blocked,
        title: props.state.canStart ? '' : '已有审核在进行中，同一时间只允许一条',
        onClick: function () {
          if (needsConfirm) { setConfirming(true); return }
          props.start(props.task, { retry: false })
        },
      }, busy ? '创建中…' : props.label)
    }

    function rowAction(task, state, props) {
      const key = task.seqNo || task.name
      const audit = state.audits ? state.audits[key] : null
      const cloud = state.ossIndex ? state.ossIndex[key] : null
      if (!audit) {
        // 云端已有审核意见 = 这条报告被审过。此时主按钮是「重新审核」
        // （要二次确认），而不是「AI 审核」—— 否则会让人以为从来没审过。
        const hasCloud = !!(cloud && cloud.htmlKey)
        return React.createElement('div', null,
          React.createElement(StartButton, {
            state: state, key: key, taskKey: key, task: task, start: props.startAudit,
            label: hasCloud ? '重新审核' : 'AI 审核', confirm: hasCloud,
          }),
          React.createElement(AuditInfoButton, { task: task, cloud: cloud, openAuditInfo: props.openAuditInfo }),
          React.createElement(CloudButtons, { cloud: cloud, busy: state.cloudBusy, openCloud: props.openCloud }),
          !state.canDispatch
            ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '4px' } }, '需先通过钉钉认证')
            : (!state.canStart ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '4px' } }, '已有审核在进行中') : null),
        )
      }
      const done = audit.status === 'done'
      const running = audit.status === 'running'
      const stopped = audit.status === 'stopped'
      const uploaded = !!audit.uploadedAt
      // 子会话还活着（运行中、或活着但这两轮之间没有输出）。
      // 活着 → 只能「停止」；已经结束（或已从清单里消失）→ 才能「重新审核」。
      // 两者互斥，正是为了不给「运行中还能另起一条」这种口子：
      // 同时跑两条同报告，案例目录会被两个子会话交叉写。
      const childLive = !audit.ended && !stopped && (audit.childAlive === true || running)
      return React.createElement('div', null,
        running
          ? React.createElement('span', { className: 'wb-badge wb-medium' }, '审核中')
          : (stopped
              ? React.createElement('span', { className: 'wb-badge wb-low' }, '已停止')
              : (audit.status === 'failed'
                  ? React.createElement('span', { className: 'wb-badge wb-high' }, '已中断')
                  : React.createElement('span', { className: 'wb-badge ' + (done ? 'wb-ok' : 'wb-low') }, done ? '已出结果' : '未出结果'))),
        (audit.childAlive === true && !running) ? React.createElement('span', { className: 'wb-badge wb-medium', style: { marginLeft: '5px' } }, '会话仍存活') : null,
        audit.attempt > 1 ? React.createElement('span', { className: 'wb-badge wb-low', style: { marginLeft: '5px' } }, '第 ' + audit.attempt + ' 次') : null,
        uploaded ? React.createElement('span', { className: 'wb-badge wb-ok', style: { marginLeft: '5px' } }, '已上云') : null,
        audit.uploadError ? React.createElement('span', { className: 'wb-badge wb-high', style: { marginLeft: '5px' } }, '上云失败') : null,
        audit.startedAt ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '4px', wordBreak: 'break-all' } },
          '启动 ' + fmtTime(audit.startedAt) + (audit.attempt > 1 ? '（第 ' + audit.attempt + ' 次）' : '')
        ) : null,
        !running && audit.stopReason ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '4px', wordBreak: 'break-all' } }, audit.stopReason) : null,
        audit.uploadError ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '4px', wordBreak: 'break-all' } }, audit.uploadError) : null,
        React.createElement('div', { className: 'wb-row', style: { marginTop: '5px' } },
          // 停止入口只在子会话**还真的活着**时出现：Host 按父会话的子代理清单
          // 给出 childAlive，比我们自己猜状态可靠。status==='running' 作为
          // 轮询还没跟上的兜底。
          (childLive && audit.childId) ? React.createElement('button', {
            className: 'wb-btn wb-btn-w wb-btn-s', type: 'button',
            disabled: !!state.stopBusy,
            onClick: function () { props.stopAudit(audit.childId) },
          }, state.stopBusy ? '停止中…' : '停止') : null,
          React.createElement(AuditInfoButton, { task: task, cloud: cloud, openAuditInfo: props.openAuditInfo }),
          React.createElement(CloudButtons, { cloud: cloud, busy: state.cloudBusy, openCloud: props.openCloud }),
          audit.htmlFile ? React.createElement('button', {
            className: 'wb-btn wb-btn-s', type: 'button',
            onClick: function () { props.openHtml(audit) },
          }, '本地 HTML') : null,
          audit.childId ? React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', onClick: function () { props.openSession(audit) } }, '查看会话') : null,
          (done && !uploaded) ? React.createElement('button', {
            className: 'wb-btn wb-btn-s', type: 'button', disabled: !!state.retryBusy,
            onClick: function () { props.retryUpload(audit) },
          }, state.retryBusy ? '重传中…' : '重传 OSS') : null,
          // 运行中不给「另起一条」：要先停止，再重新审核。
          childLive ? null : React.createElement(StartButton, {
            state: state, key: key, taskKey: key, task: task, start: props.startAudit,
            label: '重新审核', confirm: true,
          }),
        ),
      )
    }

    function ReportPane(props) {
      const state = props.state
      const [view, setView] = React.useState('pending')
      const total = state.total || 0
      const size = state.pageSize || 20
      const pages = total > 0 ? Math.max(1, Math.ceil(total / size)) : 1
      const modeText = state.filterMode === 'equal' ? ' · 精确匹配'
        : (state.filterMode === 'contains' ? ' · 模糊匹配' : '')
      const cloudCount = state.ossIndex ? Object.keys(state.ossIndex).length : 0
      const taskBySeq = {}
      ;(state.tasks || []).forEach(function (task) { taskBySeq[task.seqNo || task.name] = task })
      const resultItems = Object.keys(state.ossIndex || {}).map(function (key) { return state.ossIndex[key] })
        .filter(function (item) { return !!(item && (item.htmlKey || item.jsonKey)) })
        .sort(function (a, b) { return String(b.seqNo || '').localeCompare(String(a.seqNo || '')) })
      return React.createElement('div', null,
        props.noticeNode,
        state.parentIssue
          ? React.createElement('div', { className: 'wb-notice wb-notice-w' }, state.parentIssue)
          : null,
        state.activeKey
          ? React.createElement('div', { className: 'wb-notice wb-notice-w' },
              '已有审核进行中：' + state.activeKey + '（同一时间只允许一条，其它条目已禁用）。',
              React.createElement('div', { className: 'wb-row', style: { marginTop: '8px' } },
                React.createElement('button', {
                  className: 'wb-btn wb-btn-w', type: 'button', disabled: !!state.stopBusy,
                  onClick: function () { props.stopAudit('') },
                }, state.stopBusy ? '停止中…' : '停止这条审核'),
                React.createElement('span', { className: 'wb-muted', style: { flex: '1 1 260px' } },
                  '停止会取消子会话剩余工作并释放占用，已产出的文件保留。'
                ),
              ),
              React.createElement('div', { style: { marginTop: '6px' } },
                React.createElement('button', {
                  className: 'wb-btn wb-btn-s', type: 'button', disabled: state.releaseBusy,
                  onClick: function () { props.releaseActive() },
                }, state.releaseBusy ? '释放中…' : '只释放占用（不停子会话）'),
                React.createElement('span', { className: 'wb-muted', style: { marginLeft: '8px' } },
                  '子会话其实还在跑、只是状态没更新时用这个。'
                ),
              ),
            )
          : null,
        state.ossIndexError
          ? React.createElement('div', { className: 'wb-notice wb-notice-w' },
              '云端审核结果清单没拉到（不影响氚云列表）：' + state.ossIndexError)
          : null,
        React.createElement('div', { className: 'wb-page-tabs' },
          React.createElement('button', {
            className: 'wb-page-tab' + (view === 'pending' ? ' wb-page-tab-on' : ''), type: 'button',
            onClick: function () { setView('pending') },
          }, '待审核报告', React.createElement('span', { className: 'wb-page-count' }, String(total))),
          React.createElement('button', {
            className: 'wb-page-tab' + (view === 'results' ? ' wb-page-tab-on' : ''), type: 'button',
            onClick: function () { setView('results') },
          }, 'AI审核结果', React.createElement('span', { className: 'wb-page-count' }, String(cloudCount))),
        ),
        React.createElement(Card, {
          title: view === 'pending' ? '氚云 · 报告审核' : 'OSS · 最新 AI 审核报告',
          extra: React.createElement('span', { className: 'wb-muted' },
            view === 'pending'
              ? ((state.tasks === null ? '未拉取' : ('共 ' + total + ' 条')) +
                (state.ossLoading ? ' · 云端清单拉取中…' : (' · 已审核 ' + cloudCount + ' 个')))
              : (state.ossLoading ? '云端清单拉取中…' : ('共 ' + resultItems.length + ' 个'))),
        },
          view === 'pending' ? React.createElement('div', { className: 'wb-row' },
            React.createElement('input', {
              className: 'wb-input wb-mono', style: { width: '270px' },
              placeholder: '按报告流水号检索，如 2026-302584-LX10102-BG8734',
              value: state.query,
              onChange: function (e) { props.setQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') props.search() },
            }),
            React.createElement('button', { className: 'wb-btn wb-btn-p', type: 'button', disabled: state.busy === 'pending', onClick: function () { props.search() } }, '检索'),
            React.createElement('button', { className: 'wb-btn', type: 'button', disabled: state.busy === 'pending', onClick: function () { props.clearSearch() } }, '清除'),
            React.createElement('button', { className: 'wb-btn', type: 'button', disabled: state.busy === 'pending', onClick: function () { props.load(true) } }, state.busy === 'pending' ? '拉取中…' : '刷新数据'),
          ) : React.createElement('div', { className: 'wb-row' },
            React.createElement('button', { className: 'wb-btn', type: 'button', disabled: state.ossLoading, onClick: function () { props.refreshCloud() } },
              state.ossLoading ? '刷新中…' : '刷新审核报告清单'),
            React.createElement('span', { className: 'wb-muted' }, '这里只列举对象名称；点击“审核信息”后才读取对应 JSON。'),
          ),
          view === 'pending' ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '6px' } },
            state.formName ? ('已定位表单 · ' + state.formName) : '首次拉取会先从氚云自动定位「报告审核」表单'
          ) : null,
          view === 'pending' && state.workspacePath
            ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '4px', wordBreak: 'break-all' } },
                '案例根目录 · ' + state.workspacePath + (state.workspaceSource ? '（' + (state.workspaceSource === 'saved' ? '上次选择' : (state.workspaceSource === 'manifest-workspace' ? '清单指定' : '手动选择')) + '）' : '')
              )
            : null,
          view === 'pending' && state.boundParent
            ? React.createElement('div', { className: 'wb-muted wb-mono', style: { marginTop: '4px', wordBreak: 'break-all' } },
                '审核挂靠的顶层会话 · ' + String(state.boundParent).slice(0, 8) + '…（审核只挂一层子代理，深度 1）')
            : (view === 'pending' ? React.createElement('div', { className: 'wb-muted', style: { marginTop: '4px' } },
                '尚未登记审核父级：请在一个顶层会话里打开一次工作台运行卡片。')
              : null),
          view === 'pending' ? React.createElement('div', { className: 'wb-row', style: { marginTop: '10px' } },
            React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: state.busy === 'pending' || state.page <= 1, onClick: function () { props.goPage(state.page - 1) } }, '上一页'),
            React.createElement('span', { className: 'wb-muted' }, '第 ' + state.page + ' / ' + pages + ' 页 · 共 ' + total + ' 条' + modeText),
            React.createElement('button', { className: 'wb-btn wb-btn-s', type: 'button', disabled: state.busy === 'pending' || state.page >= pages, onClick: function () { props.goPage(state.page + 1) } }, '下一页'),
            React.createElement('span', { className: 'wb-muted', style: { marginLeft: '12px' } }, '每页'),
            React.createElement('select', {
              className: 'wb-input', value: String(size),
              onChange: function (e) { props.setPageSize(Number(e.target.value)) },
            }, [10, 20, 50, 100].map(function (n) {
              return React.createElement('option', { key: n, value: String(n) }, String(n) + ' 条')
            })),
          ) : null,
          view === 'pending' ? props.escalateNode : null,
          view === 'pending' && state.tasks === null
            ? React.createElement('div', { className: 'wb-empty' }, '正在从氚云取回报告审核记录…')
            : view === 'pending' && state.tasks.length === 0
              ? React.createElement('div', { className: 'wb-empty' }, '没有匹配的报告审核记录。')
              : view === 'pending' ? React.createElement('table', { className: 'wb-tb' },
                React.createElement('thead', null, React.createElement('tr', null,
                  React.createElement('th', null, '项目'),
                  React.createElement('th', null, '业务 / 风险'),
                  React.createElement('th', null, '人工复核进度'),
                  React.createElement('th', null, 'AI 审核与操作'),
                )),
                React.createElement('tbody', null, state.tasks.map((task, i) => React.createElement('tr', { key: i },
                  React.createElement('td', null,
                    React.createElement('div', { className: 'wb-review-main' }, task.project || task.name || '—'),
                    React.createElement('div', { className: 'wb-muted wb-mono' }, task.seqNo || task.name)),
                  React.createElement('td', null, task.business || '—',
                    task.risk ? React.createElement('div', { style: { marginTop: '4px' } }, React.createElement('span', { className: 'wb-badge wb-low' }, task.risk)) : null),
                  React.createElement('td', null,
                    React.createElement('div', { className: 'wb-review-main' }, [task.reviewLevel, task.reviewState].filter(Boolean).join(' · ') || '—'),
                    React.createElement('div', { className: 'wb-muted' }, task.currentNode || '—')),
                  React.createElement('td', null, rowAction(task, state, props)),
                ))),
              ) : resultItems.length === 0
                ? React.createElement('div', { className: 'wb-empty' }, 'OSS 中还没有 AI 审核报告。')
                : React.createElement('table', { className: 'wb-tb' },
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', null, '报告流水号'),
                    React.createElement('th', null, '人工复核进度'),
                    React.createElement('th', null, '文件状态'),
                    React.createElement('th', null, '操作'),
                  )),
                  React.createElement('tbody', null, resultItems.map(function (cloud) {
                    const task = taskBySeq[cloud.seqNo] || null
                    const complete = !!(cloud.htmlKey && cloud.jsonKey)
                    return React.createElement('tr', { key: cloud.seqNo },
                      React.createElement('td', { className: 'wb-mono' }, cloud.seqNo || '—'),
                      React.createElement('td', null, task
                        ? React.createElement('div', null,
                            React.createElement('div', { className: 'wb-review-main' }, [task.reviewLevel, task.reviewState].filter(Boolean).join(' · ') || '—'),
                            React.createElement('div', { className: 'wb-muted' }, task.currentNode || '—'))
                        : React.createElement('span', { className: 'wb-muted' }, '当前氚云页未载入')),
                      React.createElement('td', null, React.createElement('span', {
                        className: 'wb-badge ' + (complete ? 'wb-ok' : 'wb-medium'),
                      }, complete ? '报告完整' : '结果不完整')),
                      React.createElement('td', null, React.createElement('div', { className: 'wb-row' },
                        React.createElement(AuditInfoButton, { task: task, cloud: cloud, openAuditInfo: props.openAuditInfo }),
                        React.createElement(CloudButtons, { cloud: cloud, busy: state.cloudBusy, openCloud: props.openCloud }))),
                    )
                  })),
                ),
        ),
        state.handoff ? React.createElement(Handoff, { prompt: state.handoff.prompt }) : null,
        React.createElement(AuditInfoDrawer, { state: props.auditInfo, close: props.closeAuditInfo }),
      )
    }

    function AuditParentButton(props) {
      const [bound, setBound] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [isSub, setIsSub] = React.useState(false)
      const sid = props && props.sessionId ? String(props.sessionId) : ''

      function bind() {
        if (!sid) return
        call('workbench:bind-session', { sessionId: sid }).then(function (r) {
          // 无论成败都交给 Host 的权威视图：失败（子代理不能当父级）时它会带回
          // 原来那个合法的顶层父级，工作台要把它显示出来，不然用户不知道
          // 审核到底挂在哪。
          wbAdopt(r)
          if (r && r.ok) { setBound(true); setErr(''); setIsSub(false); return }
          setBound(false)
          setIsSub(!!(r && r.subagent === true))
          setErr((r && r.error) || '登记失败')
        }).catch(function (e) { setErr(errText(e)) })
      }

      React.useEffect(function () {
        bind()
        return undefined
      }, [])

      if (!sid) return null
      return React.createElement('button', {
        className: 'wb-btn wb-btn-s',
        type: 'button',
        title: err || '审核子会话会继承本会话的 cwd 与沙箱边界',
        onClick: bind,
      }, err ? (isSub ? '子代理不能当审核父级' : '登记失败') : (bound ? '子会话父级 ✓' : '登记为子会话父级'))
    }

    function Workbench() {
      const [boot, setBoot] = React.useState(wbCache.boot)
      const [tab, setTab] = React.useState('env')
      const [root, setRoot] = React.useState('')
      const [sessionRoot, setSessionRoot] = React.useState('')
      const [tasks, setTasks] = React.useState(null)
      const [formName, setFormName] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [appliedQuery, setAppliedQuery] = React.useState('')
      const [page, setPage] = React.useState(1)
      const [pageSize, setPageSizeState] = React.useState(20)
      const [total, setTotal] = React.useState(0)
      const [filterMode, setFilterMode] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [escalate, setEscalate] = React.useState(null)
      const [handoff, setHandoff] = React.useState(null)
      const [cloudBusy, setCloudBusy] = React.useState(false)
      const [ossIndex, setOssIndex] = React.useState(wbCache.ossIndex || {})
      const [ossIndexError, setOssIndexError] = React.useState('')
      const [ossLoading, setOssLoading] = React.useState(false)
      const [linkMode, setLinkMode] = React.useState('')
      const [linkTtl, setLinkTtl] = React.useState(0)
      const [env, setEnv] = React.useState(wbCache.env)
      const [envAt, setEnvAt] = React.useState(wbCache.envAt)
      const [envBusy, setEnvBusy] = React.useState('')
      const [manifestSource, setManifestSource] = React.useState('')
      const [installMsg, setInstallMsg] = React.useState('')
      const [installPrompt, setInstallPrompt] = React.useState(wbCache.installPrompt)
      const [reloginBusy, setReloginBusy] = React.useState(false)
      const [dwsBusy, setDwsBusy] = React.useState(false)
      const [trust, setTrustState] = React.useState({ h3yun: false })
      const [audits, setAudits] = React.useState(wbCache.audits || {})
      const [auditBusy, setAuditBusy] = React.useState('')
      const [activeKey, setActiveKey] = React.useState('')
      const [releaseBusy, setReleaseBusy] = React.useState(false)
      const [stopBusy, setStopBusy] = React.useState('')
      const [retryBusy, setRetryBusy] = React.useState('')
      const [wsMsg, setWsMsg] = React.useState('')
      const [workspaceId, setWorkspaceId] = React.useState('')
      const [workspaceInfo, setWorkspace] = React.useState(wbCache.workspace || null)
      const [sessionWorkspace, setSessionWorkspace] = React.useState(wbCache.sessionWorkspace || null)
      const [wsBusy, setWsBusy] = React.useState(false)
      const [boundParent, setBoundParent] = React.useState(wbCache.parentSessionId || (wbCache.boot && wbCache.boot.parentSessionId) || '')
      const [parentIssue, setParentIssue] = React.useState(wbCache.parentIssue || '')
      const [ossLoaded, setOssLoaded] = React.useState(wbCache.ossLoaded === true)
      const [auditInfo, setAuditInfo] = React.useState(null)

      function storeEnv(r) {
        if (!r) return
        wbCache.env = r
        wbCache.envAt = Date.now()
        setEnv(r)
        setEnvAt(wbCache.envAt)
        if (r.manifestSource) setManifestSource(r.manifestSource)
        if (r.trust) setTrustState(r.trust)
        if (r.workspace) { wbCache.workspace = r.workspace; setWorkspace(r.workspace) }
        if (r.sessionWorkspace) { wbCache.sessionWorkspace = r.sessionWorkspace; setSessionWorkspace(r.sessionWorkspace) }
        if (r.oss) {
          setLinkMode(String(r.oss.linkMode || 'signed'))
          setLinkTtl(Number(r.oss.linkTtl) || 3600)
        }
      }

      function applyAudits(r) {
        if (!r || !r.ok) return
        const next = {}
        const list = r.audits || []
        for (let i = 0; i < list.length; i += 1) next[list[i].key] = list[i]
        wbCache.audits = next
        setAudits(next)
        setActiveKey(String((r.active && r.active.key) || ''))
      }

      function applyCloud(r) {
        setOssLoading(false)
        wbCache.ossLoaded = true
        setOssLoaded(true)
        if (!r) { setOssIndexError('无返回'); return }
        if (!r.ok) { setOssIndexError(String(r.error || '未知原因')); return }
        const next = r.items || {}
        wbCache.ossIndex = next
        setOssIndex(next)
        setOssIndexError('')
      }

      function loadCloud(clearDetails) {
        wbCache.ossLoaded = true
        setOssLoaded(true)
        if (clearDetails === true) {
          wbCache.auditInfo = {}
          wbCache.auditInfoRequest += 1
          setAuditInfo(null)
        }
        setOssLoading(true)
        return call('workbench:oss-index', {}).then(function (r) { applyCloud(r) }).catch(function (e) {
          setOssLoading(false)
          setOssIndexError(errText(e))
        })
      }

      function openAuditInfo(task, cloud) {
        const key = String((cloud && cloud.jsonKey) || '')
        const requestId = wbCache.auditInfoRequest + 1
        wbCache.auditInfoRequest = requestId
        if (!key) {
          setAuditInfo({ seqNo: task && task.seqNo, task: task || null, info: null, loading: false, error: '该项目没有审核结果 JSON。' })
          return
        }
        const cached = wbCache.auditInfo[key]
        if (cached) {
          setAuditInfo({ seqNo: (cloud && cloud.seqNo) || '', task: task || null, info: cached, loading: false, error: '' })
          return
        }
        setAuditInfo({ seqNo: (cloud && cloud.seqNo) || '', task: task || null, info: null, loading: true, error: '' })
        call('workbench:oss-result', { key: key }).then(function (r) {
          if (wbCache.auditInfoRequest !== requestId) return
          if (!r || !r.ok) {
            setAuditInfo({ seqNo: (cloud && cloud.seqNo) || '', task: task || null, info: null, loading: false, error: String((r && r.error) || '读取审核信息失败') })
            return
          }
          wbCache.auditInfo[key] = r.info
          setAuditInfo({ seqNo: (cloud && cloud.seqNo) || '', task: task || null, info: r.info, loading: false, error: '' })
        }).catch(function (error) {
          if (wbCache.auditInfoRequest !== requestId) return
          setAuditInfo({ seqNo: (cloud && cloud.seqNo) || '', task: task || null, info: null, loading: false, error: errText(error) })
        })
      }

      function loadEnv(source) {
        setEnvBusy('refresh')
        setNotice(null)
        call('workbench:env', { source: source === undefined ? manifestSource : source }).then(function (r) {
          setEnvBusy('')
          storeEnv(r)
        }).catch(function (e) {
          setEnvBusy('')
          setNotice({ kind: 'e', text: errText(e) })
        })
      }

      function refreshPrompt() {
        setInstallMsg('')
        call('workbench:install-prompt', { workspace: root }).then(function (r) {
          if (!r || !r.ok) { setInstallMsg('生成失败：' + String((r && r.error) || '未知原因')); return }
          const next = { url: r.url, prompt: r.prompt }
          wbCache.installPrompt = next
          setInstallPrompt(next)
        }).catch(function (e) { setInstallMsg('生成失败：' + errText(e)) })
      }

      React.useEffect(function () {
        let alive = true
        if (!wbCache.boot) {
          call('workbench:boot', null).then(function (r) {
            if (!alive || !r) return
            wbCache.boot = r
            setBoot(r)
            if (r.root) setRoot(r.root)
            if (r.sessionRoot) setSessionRoot(r.sessionRoot)
            if (r.formName) setFormName(r.formName)
            if (r.manifestSource) setManifestSource(r.manifestSource)
            if (r.workspace) { wbCache.workspace = r.workspace; setWorkspace(r.workspace) }
            if (r.sessionWorkspace) { wbCache.sessionWorkspace = r.sessionWorkspace; setSessionWorkspace(r.sessionWorkspace) }
            if (r.parentSessionId) { wbCache.parentSessionId = r.parentSessionId; setBoundParent(r.parentSessionId) }
            if (r.active) setActiveKey(String(r.active.key || ''))
          }).catch(function () {})
        } else {
          if (wbCache.boot.root) setRoot(wbCache.boot.root)
          if (wbCache.boot.sessionRoot) setSessionRoot(wbCache.boot.sessionRoot)
          if (wbCache.boot.formName) setFormName(wbCache.boot.formName)
          if (wbCache.boot.manifestSource) setManifestSource(wbCache.boot.manifestSource)
          if (wbCache.workspace) setWorkspace(wbCache.workspace)
          if (wbCache.sessionWorkspace) setSessionWorkspace(wbCache.sessionWorkspace)
          if (wbCache.parentSessionId) setBoundParent(wbCache.parentSessionId)
        }
        if (!wbCache.env) {
          call('workbench:env', null).then(function (r) {
            if (!alive) return
            storeEnv(r)
          }).catch(function () {})
        }
        if (!wbCache.installPrompt) {
          call('workbench:install-prompt', {}).then(function (r) {
            if (!alive || !r || !r.ok) return
            const next = { url: r.url, prompt: r.prompt }
            wbCache.installPrompt = next
            setInstallPrompt(next)
          }).catch(function () {})
        }
        call('workbench:audit-status', {}).then(function (r) {
          if (!alive) return
          applyAudits(r)
        }).catch(function () {})
        return function () { alive = false }
      }, [])

      // 绑定父会话的组件（运行卡片、会话头按钮）拿到 Host 的权威视图后广播，
      // 工作台在这里接住，不必为了工作空间字段再跑一次自检。
      React.useEffect(function () {
        const listener = function () {
          if (wbCache.workspace) setWorkspace(wbCache.workspace)
          if (wbCache.sessionWorkspace) setSessionWorkspace(wbCache.sessionWorkspace)
          if (wbCache.parentSessionId) setBoundParent(wbCache.parentSessionId)
          setParentIssue(wbCache.parentIssue || '')
        }
        wbListeners.push(listener)
        return function () {
          const i = wbListeners.indexOf(listener)
          if (i >= 0) wbListeners.splice(i, 1)
        }
      }, [])

      const blocked = env && env.blocked ? env.blocked : []
      const envReady = blocked.length === 0
      const svcOk = function (id) {
        if (!env || !env.services) return false
        const hit = env.services.filter(function (s) { return s.id === id })[0]
        return !!(hit && hit.ok)
      }
      const h3Ready = svcOk('h3yun')
      const dtReady = svcOk('dingtalk')
      const dotColor = envReady ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'
      const anyAuditRunning = !!activeKey

      React.useEffect(function () {
        if (!anyAuditRunning) return undefined
        const dispose = ctx.interval(function () {
          call('workbench:audit-status', {}).then(applyAudits).catch(function () {})
        }, 10000)
        return function () { dispose() }
      }, [anyAuditRunning])

      function adoptWorkspace(r, fallbackPath) {
        // Host 是唯一权威：它把选择持久化到 ~/.dsh/crwu-workbench.json，
        // 并回传 workspace / sessionWorkspace 的官方视图。
        if (r && r.workspace) {
          wbCache.workspace = r.workspace
          setWorkspace(r.workspace)
          setWorkspaceId(String(r.workspace.id || ''))
          if (r.workspace.path) setRoot(r.workspace.path)
        }
        if (r && r.sessionWorkspace) {
          wbCache.sessionWorkspace = r.sessionWorkspace
          setSessionWorkspace(r.sessionWorkspace)
        }
        if (!r || !r.workspace || !r.workspace.path) {
          if (fallbackPath) { setRoot(fallbackPath); setWorkspace({ chosen: true, path: fallbackPath, title: fallbackPath, id: '', source: 'manual' }) }
        }
      }

      function pickWorkspace() {
        const uiWorkspace = ctx.get('uiWorkspace')
        const workspaces = ctx.get('workspaces')
        if (!uiWorkspace || !workspaces) { setWsMsg('工作空间服务不可用'); return }
        setWsBusy(true)
        uiWorkspace.pickDirectory().then(function (path) {
          if (!path) { setWsBusy(false); setWsMsg('已取消选择'); return }
          return workspaces.create({ path: path }).then(function (view) {
            setWorkspaceId(String(view.workspaceId))
            setRoot(view.path)
            return call('workbench:workspace', { path: view.path, id: String(view.workspaceId), title: String(view.title || '') }).then(function (r) {
              adoptWorkspace(r, view.path)
              setWsBusy(false)
              setWsMsg('案例根目录已选定：' + view.path + '（已记住，下次不用再选）')
              return uiWorkspace.openWorkspace(view.workspaceId).catch(function () {}).then(function () { loadEnv(); refreshPrompt() })
            })
          })
        }).catch(function (e) { setWsBusy(false); setWsMsg('选定失败：' + errText(e)) })
      }

      function autoWorkspace() {
        setWsBusy(true)
        call('workbench:workspace-auto', null).then(function (r) {
          adoptWorkspace(r, '')
          setWsBusy(false)
          setWsMsg(r && r.workspace && r.workspace.chosen
            ? ('已恢复自动识别：' + r.workspace.path)
            : '没有可自动识别的工作空间，请手动选择。')
          loadEnv(); refreshPrompt()
        }).catch(function (e) { setWsBusy(false); setWsMsg('恢复自动识别失败：' + errText(e)) })
      }

      function createWorkspace() {
        const uiWorkspace = ctx.get('uiWorkspace')
        const workspaces = ctx.get('workspaces')
        if (!uiWorkspace || !workspaces) { setWsMsg('工作空间服务不可用'); return }
        setWsBusy(true)
        uiWorkspace.pickDirectory().then(function (parent) {
          if (!parent) { setWsBusy(false); setWsMsg('已取消'); return }
          return uiWorkspace.createDirectory(parent, 'crwu-workspace').then(function (path) {
            return workspaces.create({ path: path }).then(function (view) {
              setWorkspaceId(String(view.workspaceId))
              setRoot(view.path)
              return call('workbench:workspace', { path: view.path, id: String(view.workspaceId), title: String(view.title || '') }).then(function (r) {
                adoptWorkspace(r, view.path)
                setWsBusy(false)
                setWsMsg('已新建并选定：' + view.path)
                return uiWorkspace.openWorkspace(view.workspaceId).catch(function () {}).then(function () { loadEnv(); refreshPrompt() })
              })
            })
          })
        }).catch(function (e) { setWsBusy(false); setWsMsg('新建失败：' + errText(e)) })
      }

      function openWorkspaceSession() {
        const uiWorkspace = ctx.get('uiWorkspace')
        const workspaces = ctx.get('workspaces')
        if (!uiWorkspace) { setWsMsg('工作空间服务不可用'); return }
        const target = (workspaceInfo && workspaceInfo.path) || root
        if (!target) { setWsMsg('请先选定案例根目录'); return }
        const open = function (id) {
          uiWorkspace.openWorkspace(id).then(function () {
            setWsMsg('已在该工作空间打开新会话：' + target + '。在这个会话里打开工作台，审核子会话的 cwd 就会是它。')
          }).catch(function (e) { setWsMsg('打开会话失败：' + errText(e)) })
        }
        const known = (workspaceInfo && workspaceInfo.id) || workspaceId
        if (known) { open(known); return }
        if (!workspaces) { setWsMsg('工作空间服务不可用'); return }
        workspaces.create({ path: target }).then(function (view) {
          setWorkspaceId(String(view.workspaceId))
          open(view.workspaceId)
        }).catch(function (e) { setWsMsg('注册工作空间失败：' + errText(e)) })
      }

      function setTrust(value) {
        setTrustState({ h3yun: value })
        call('workbench:trust', { h3yun: value }).catch(function () {})
      }

      function h3yunLogin() {
        setReloginBusy(true)
        setInstallMsg('已请求打开浏览器，请用钉钉扫码完成认证…')
        call('workbench:relogin', null).then(function (r) {
          setReloginBusy(false)
          if (r && r.ok) { setInstallMsg('氚云认证成功。'); loadEnv() }
          else setInstallMsg('氚云认证未完成：' + String((r && (r.error || r.stderrTail)) || '未知原因').slice(0, 300))
        }).catch(function (e) { setReloginBusy(false); setInstallMsg('氚云认证请求失败：' + errText(e)) })
      }

      function dwsLogin(device) {
        setDwsBusy(true)
        setInstallMsg(device ? '已发起钉钉设备流登录，请按提示完成授权…' : '已请求打开浏览器，请完成钉钉扫码授权…')
        call('workbench:dws-login', { device: device === true }).then(function (r) {
          setDwsBusy(false)
          if (r && r.ok) { setInstallMsg('钉钉登录成功。'); loadEnv() }
          else setInstallMsg('钉钉登录未完成：' + String((r && (r.error || r.stderrTail || r.stdoutTail)) || '未知原因').slice(0, 400))
        }).catch(function (e) { setDwsBusy(false); setInstallMsg('钉钉登录请求失败：' + errText(e)) })
      }

      function openSession(audit) {
        const sessions = ctx.get('sessions')
        const childId = audit && audit.childId ? String(audit.childId) : ''
        if (!childId) { setNotice({ kind: 'e', text: '该记录没有子会话 id。' }); return }
        if (!sessions) { setNotice({ kind: 'e', text: '客户端 sessions 服务不可用。' }); return }
        const parentId = String((audit && audit.parentSessionId) || (boot && boot.parentSessionId) || '')
        if (!parentId) { setNotice({ kind: 'e', text: '缺少父会话 id。请先在对话里打开一次工作台运行卡片完成登记。' }); return }
        const modes = [String((audit && audit.mode) || 'one-shot'), 'one-shot', 'continuable']
        let done = false
        const attempt = function () {
          if (done) return
          let last = ''
          for (let i = 0; i < modes.length; i += 1) {
            try {
              sessions.openSubagent({ parentSessionId: parentId, childSessionId: childId, mode: modes[i] })
              done = true
              // openSubagent 只在会话控制器里选中该子会话，不切主面板。
              // 当前主面板是工作台自己，不切过去就“打开了但看不见”。
              if (layout) layout.selectPanel('conversation')
              setNotice({ kind: 'i', text: '已打开子会话 ' + childId.slice(0, 8) + '…' })
              return
            } catch (error) { last = errText(error) }
          }
          setNotice({ kind: 'e', text: '打开子会话失败：' + last })
        }
        try {
          if (typeof sessions.refreshSubagents === 'function') sessions.refreshSubagents(parentId).then(attempt, attempt)
          else attempt()
        } catch (error) {
          setNotice({ kind: 'e', text: '打开子会话失败：' + errText(error) })
        }
      }

      function openCloud(key) {
        const k = String(key || '')
        if (!k) return
        setCloudBusy(true)
        setNotice(null)
        call('workbench:oss-link', { key: k }).then(function (r) {
          setCloudBusy(false)
          if (r && r.ok) setNotice({ kind: 'i', text: '已打开云端对象（' + (r.mode === 'public' ? '公有链接' : '签名链接 ' + String(r.ttl || 0) + 's') + '）：' + (r.url || '') })
          else setNotice({ kind: 'e', text: '打开云端对象失败：' + String((r && r.error) || '未知原因') })
        }).catch(function (e) { setCloudBusy(false); setNotice({ kind: 'e', text: '打开云端对象失败：' + errText(e) }) })
      }

      function openFile(path) {
        const p = String(path || '')
        if (!p) { setNotice({ kind: 'e', text: '没有可打开的文件' }); return }
        setNotice(null)
        call('workbench:open-path', { path: p }).then(function (r) {
          if (r && r.ok) setNotice({ kind: 'i', text: '已用系统默认程序打开：' + p })
          else setNotice({ kind: 'e', text: '打开失败：' + String((r && r.error) || '未知原因') })
        }).catch(function (e) { setNotice({ kind: 'e', text: '打开失败：' + errText(e) }) })
      }

      function openHtmlFile(name, dir) {
        const base = String(dir || '').replace(/\/+$/, '')
        openFile(base + '/' + String(name || ''))
      }

      // 手动重传 OSS：按记录 key 交给 Host 定位案例目录（Host 记着绝对 casePath），
      // 成功后刷新云端清单，让「云端审核意见」按钮立刻可用。
      function retryUpload(audit) {
        const key = audit && (audit.key || audit.seqNo)
        if (!key) { setNotice({ kind: 'e', text: '这条记录没有可用的标识，无法重传。' }); return }
        setRetryBusy(key)
        setNotice(null)
        call('workbench:oss-upload', { key: key }).then(function (r) {
          setRetryBusy('')
          if (!r || !r.ok) {
            setNotice({ kind: 'e', text: '重传失败：' + String((r && r.error) || '未知原因').slice(0, 300) })
            return
          }
          setNotice({ kind: 'i', text: '已重传到 ' + (r.prefix || '') + '/：' + (r.results || []).map(function (x) { return x.name }).join('、') })
          loadCloud(true)
          call('workbench:audit-status', {}).then(applyAudits).catch(function () {})
        }).catch(function (e) { setRetryBusy(''); setNotice({ kind: 'e', text: '重传失败：' + errText(e) }) })
      }

      function loadReport(escalated, ov) {
        const o = ov || {}
        const q = o.query !== undefined ? o.query : appliedQuery
        const p = o.page !== undefined ? o.page : page
        const s = o.size !== undefined ? o.size : pageSize
        setBusy('pending')
        setNotice(null)
        setEscalate(null)
        const shouldLoadCloud = o.refreshCloud === true || (!ossLoaded && wbCache.ossLoaded !== true)
        if (shouldLoadCloud) {
          wbCache.ossLoaded = true
          setOssLoaded(true)
          if (o.refreshCloud === true) {
            wbCache.auditInfo = {}
            wbCache.auditInfoRequest += 1
            setAuditInfo(null)
          }
          setOssLoading(true)
          call('workbench:oss-index', {}).then(function (result) {
            applyCloud(result)
          }).catch(function (error) {
            setOssLoading(false)
            setOssIndexError(errText(error))
          })
        }
        call('workbench:pending', { escalate: escalated === true, page: p, size: s, query: q }).then(function (r) {
          setBusy('')
          if (r && r.formName) setFormName(r.formName)
          if (!r || !r.ok) {
            setTasks([])
            setTotal(0)
            setNotice({ kind: 'e', text: (r && r.error) || '拉取报告审核记录失败' })
            if (r && r.escalateAvailable) setEscalate({ label: '以无沙箱方式重试本次氚云读取', run: function () { loadReport(true, { query: q, page: p, size: s }) } })
            return
          }
          setTasks(r.rows || [])
          setAppliedQuery(q)
          setQuery(q)
          setPage(r.page || p)
          setPageSizeState(r.size || s)
          setTotal(r.total || 0)
          setFilterMode(r.filterMode || '')
          if (r.escalated) loadEnv()
        }).catch(function (e) {
          setBusy('')
          setNotice({ kind: 'e', text: errText(e) })
        })
      }

      function startAudit(task, opts) {
        const o = opts || {}
        const key = task.seqNo || task.name
        setAuditBusy(key)
        setNotice(null)
        setHandoff(null)
        call('workbench:audit-start', {
          key: key, seqNo: task.seqNo || task.name, project: task.project || '', objectId: task.id || '',
          // 云端已有交付件但本地还没记录时，Host 的 prev 是空的 —— 只靠它判断
          // 会得到"首次审核"的提示词，子会话就可能去复用案例目录里的旧产物。
          // 所以由界面把"这是重审"这个已知事实一起传过去。
          retry: o.retry === true,
        }).then(function (r) {
          setAuditBusy('')
          if (!r || !r.ok) {
            setNotice({ kind: 'e', text: (r && r.error) || '创建审核子会话失败' })
            const lines = [
              '请按 crwu-audit 技能审核这条评估报告，走完整两阶段流程，并在阶段一冻结后完成交付与钉钉回传。',
              '',
              '- 氚云报告审核记录 ObjectId：' + (task.id || '（缺失，请先用 SeqNo 精确定位）'),
              '- 报告流水号（SeqNo）：' + (task.seqNo || task.name || '（无）'),
              '- 项目名称：' + (task.project || '（未取到）'),
            ]
            setHandoff({ task: task, prompt: lines.join('\n') })
            call('workbench:audit-status', {}).then(applyAudits).catch(function () {})
            return
          }
          const next = {}
          Object.keys(audits).forEach(function (k) { next[k] = audits[k] })
          next[key] = {
            key: key, childId: r.childId, status: 'running', ended: false,
            parentSessionId: r.parentSessionId || '', mode: r.mode || 'one-shot',
            seqNo: task.seqNo || task.name, project: task.project || '', caseName: '', resultFile: '', htmlFile: '',
            stopReason: '', uploadedAt: '', uploadError: '',
          }
          wbCache.audits = next
          setAudits(next)
          setActiveKey(key)
          const replacedNote = r.replaced
            ? ('这条任务已有子会话，已先停掉 ' + String(r.replaced).slice(0, 8) + '…' + ((r.replacedCount || 1) > 1 ? (' 等 ' + r.replacedCount + ' 条') : '') + '，')
            : ''
          setNotice({
            kind: 'i',
            text: replacedNote + '已' + (r.isRetry ? '重启' : '创建') + '审核子会话（id ' + String(r.childId).slice(0, 8) + '…'
              + (r.startedAt ? '，启动 ' + fmtTime(r.startedAt) : '') + '）。'
              + (r.isRetry ? '按「重新审核」提示词从零重跑，不读案例目录里上一轮的产物。' : '')
              + '同一时间只跑这一条，完成后会自动上云；跑偏了可以随时点「停止」。',
          })
        }).catch(function (e) {
          setAuditBusy('')
          setNotice({ kind: 'e', text: errText(e) })
        })
      }

      function releaseActive() {
        setReleaseBusy(true)
        call('workbench:audit-release', {}).then(function (r) {
          setReleaseBusy(false)
          setNotice({ kind: 'i', text: r && r.released ? ('已释放占用：' + r.released) : '当前没有占用。' })
          call('workbench:audit-status', {}).then(applyAudits).catch(function () {})
        }).catch(function (e) { setReleaseBusy(false); setNotice({ kind: 'e', text: errText(e) }) })
      }

      function stopAudit(childId) {
        // 空字符串交给 Host 自己回退到 activeChildId —— 不能拿 activeKey
        // 去顶替，那是报告流水号，不是子会话 id。
        const id = String(childId || '')
        setStopBusy(id || '__active__')
        setNotice(null)
        call('workbench:audit-stop', { childId: id }).then(function (r) {
          setStopBusy('')
          if (!r || !r.ok) { setNotice({ kind: 'e', text: (r && r.error) || '停止失败' }); return }
          const how = r.disposed ? '已取消子会话剩余工作并释放资源' : '已标记为停止（未找到运行句柄）'
          const errs = (r.errors && r.errors.length > 0) ? ('；' + r.errors.join('；')) : ''
          setNotice({ kind: errs ? 'w' : 'i', text: '审核已停止：' + how + errs })
          call('workbench:audit-status', {}).then(applyAudits).catch(function () {})
        }).catch(function (e) { setStopBusy(''); setNotice({ kind: 'e', text: errText(e) }) })
      }

      function goTab(next) {
        if (next !== 'env' && !envReady) { setTab('env'); return }
        const from = tab
        setTab(next)
        // 切进「报告审核」就直接去氚云拉一次 —— 不让用户先对着空列表点「刷新」。
        // 只在**从别的页切过来**时拉：已经停在本页再点同一个 tab 不重复请求，
        // 要手动重拉用页内的「刷新（同时拉云端）」。
        // 传 {} 而不是 {page:1}：loadReport 会取 appliedQuery / page 的当前值，
        // 否则翻到第 3 页再切出去切回来会被打回第 1 页。
        if (next === 'report' && from !== 'report') loadReport(false, {})
      }

      const noticeNode = notice
        ? React.createElement('div', { className: 'wb-notice wb-notice-' + notice.kind }, notice.text)
        : null

      const escalateNode = escalate
        ? React.createElement('div', { className: 'wb-notice wb-notice-w' },
            React.createElement('div', null, '氚云读取被会话续期拦住了：续期需要把新令牌写回系统钥匙串，当前 DSH 沙箱策略拒绝写入。'),
            React.createElement('div', { style: { marginTop: '8px' } },
              React.createElement('button', {
                className: 'wb-btn wb-btn-w', type: 'button',
                onClick: function () { const act = escalate.run; setEscalate(null); act() },
              }, escalate.label),
            ),
          )
        : null

      return React.createElement('div', { className: 'wb-root' },
        React.createElement('div', { className: 'wb-head' },
            React.createElement('div', { className: 'wb-flexline' },
              React.createElement('div', null,
                React.createElement('div', { className: 'wb-title' }, '中瑞世联工作台'),
                React.createElement('div', { className: 'wb-sub' },
                  React.createElement('span', { className: 'wb-dot', style: { background: dotColor } }),
                  (env ? (envReady ? '环境就绪' : '环境未就绪 · ' + blocked.length + ' 项') : '未自检'),
                  ' · 氚云' + (h3Ready ? '正常' : '异常'),
                  ' · 钉钉' + (dtReady ? '已登录' : '未登录'),
                  (env && env.platform ? ' · ' + env.platform : ''),
                  anyAuditRunning ? (' · 审核中：' + activeKey) : '',
                ),
              ),
              React.createElement('div', { className: 'wb-row' },
                React.createElement('button', {
                  className: 'wb-btn', type: 'button', disabled: envBusy === 'refresh',
                  onClick: function () { loadEnv() },
                }, envBusy === 'refresh' ? '自检中…' : '重新自检'),
              ),
            ),
            React.createElement('div', { className: 'wb-mods' },
              React.createElement('button', {
                className: 'wb-mod' + (tab === 'env' ? ' wb-mod-on' : ''), type: 'button',
                onClick: function () { goTab('env') },
              }, envReady ? '环境自检 · 就绪' : (env ? ('环境自检 · ' + blocked.length + ' 项未过') : '环境自检')),
              envReady ? React.createElement('button', {
                className: 'wb-mod' + (tab === 'report' ? ' wb-mod-on' : ''), type: 'button',
                onClick: function () { goTab('report') },
              }, '报告审核') : null,
              envReady ? null : React.createElement('span', { className: 'wb-lockhint' },
                env ? '环境未就绪，报告审核与审核结果已隐藏' : ''
              ),
            ),
          ),
          React.createElement('div', { className: 'wb-body' },
          tab === 'env'
            ? React.createElement(EnvPane, {
                state: {
                  env: env, envAt: envAt, envBusy: envBusy, manifestSource: manifestSource, installMsg: installMsg,
                  installPrompt: installPrompt,
                  reloginBusy: reloginBusy, dwsBusy: dwsBusy,
                  sessionRoot: sessionRoot, crwuVersion: boot ? boot.crwuVersion : '', trust: trust, wsMsg: wsMsg,
                  workspace: workspaceInfo, sessionWorkspace: sessionWorkspace,
                  wsBusy: wsBusy,
                  ossCred: env && env.ossCred ? env.ossCred : null,
                  linkMode: linkMode, linkTtl: linkTtl,
                },
                setManifestSource: setManifestSource,
                setInstallMsg: setInstallMsg,
                setTrust: setTrust,
                pickWorkspace: pickWorkspace,
                createWorkspace: createWorkspace,
                openWorkspaceSession: openWorkspaceSession,
                autoWorkspace: autoWorkspace,
                refreshEnv: function () { loadEnv() },
                refreshPrompt: refreshPrompt,
                openSession: openSession,
                h3yunLogin: h3yunLogin,
                dwsLogin: dwsLogin,
              })
            : React.createElement(ReportPane, {
                  state: {
                    tasks: tasks, busy: busy, formName: formName,
                    canDispatch: h3Ready && dtReady,
                    canStart: !activeKey,
                    activeKey: activeKey, auditBusy: auditBusy, releaseBusy: releaseBusy, stopBusy: stopBusy,
                    query: query, page: page, pageSize: pageSize, total: total, filterMode: filterMode,
                    audits: audits, handoff: handoff,
                    ossIndex: ossIndex, ossIndexError: ossIndexError, ossLoading: ossLoading,
                    cloudBusy: cloudBusy,
                    workspacePath: (workspaceInfo && workspaceInfo.path) || '',
                    workspaceSource: (workspaceInfo && workspaceInfo.source) || '',
                    boundParent: boundParent, parentIssue: parentIssue,
                  },
                  setQuery: setQuery,
                  search: function () { loadReport(false, { query: query, page: 1 }) },
                  clearSearch: function () { setQuery(''); loadReport(false, { query: '', page: 1 }) },
                  goPage: function (next) { loadReport(false, { page: next }) },
                  setPageSize: function (n) { setPageSizeState(n); loadReport(false, { size: n, page: 1 }) },
                  load: function (refreshCloud) { loadReport(false, { refreshCloud: refreshCloud === true }) },
                  refreshCloud: function () { loadCloud(true) },
                  startAudit: startAudit,
                  releaseActive: releaseActive,
                  stopAudit: stopAudit,
                  retryUpload: retryUpload,
                  openSession: openSession,
                  openHtml: function (audit) { openHtmlFile(audit.htmlFile, audit.casePath) },
                  openCloud: openCloud,
                  openAuditInfo: openAuditInfo,
                  auditInfo: auditInfo,
                  closeAuditInfo: function () { wbCache.auditInfoRequest += 1; setAuditInfo(null) },
                  noticeNode: noticeNode,
                  escalateNode: escalateNode,
                }),
        ),
      )
    }

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const stroke = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: stroke, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        React.createElement('rect', { x: 3, y: 3.5, width: 18, height: 17, rx: 3 }),
        React.createElement('path', { d: 'M7.5 8.5h5.5' }),
        React.createElement('path', { d: 'M7.5 12.5h9' }),
        React.createElement('path', { d: 'M7.5 16.5h4' }),
      )
    }

    function RunCardAction(props) {
      React.useEffect(function () {
        if (props && props.sessionId) {
          call('workbench:bind-session', { sessionId: String(props.sessionId) }).then(wbAdopt).catch(function () {})
        }
        return undefined
      }, [])
      return React.createElement('div', { style: { padding: '8px 2px' } },
        React.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px' } },
          '中瑞世联工作台：环境自检 → 报告审核（单条）→ 自动上云 → 直接开云端审核意见。'
        ),
        React.createElement('button', {
          className: 'wb-btn wb-btn-p', type: 'button',
          onClick: function () { if (layout) layout.selectPanel('crwu-workbench') },
        }, '打开工作台'),
      )
    }

    if (slots !== undefined) {
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: 'crwu-workbench', order: 20, label: '中瑞世联工作台' },
          function (p) { return React.createElement(PanelIcon, p) },
        )
      })
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: 'crwu-workbench' },
          function () { return React.createElement(Workbench, null) },
        )
      })
      slots.inject('tool.view.cordis', function () {
        return slots.register(
          { name: 'tool.view.cordis', key: 'self' },
          function (p) { return React.createElement(RunCardAction, p) },
        )
      })
      slots.inject('conversation.session.header.utilities', function () {
        return slots.register(
          { name: 'conversation.session.header.utilities', id: 'crwu-audit-parent', order: 5, label: '子会话父级' },
          function (p) { return React.createElement(AuditParentButton, p) },
        )
      })
    }

    console.log('中瑞世联工作台 Client 半已装配 ' + JSON.stringify({
      rev: 'pkg-43',
      views: typeof Workbench === 'function' && typeof WorkspaceCard === 'function' && typeof ReportPane === 'function',
      adopt: typeof wbAdopt === 'function' && typeof wbNotify === 'function',
    }))
  },
}
