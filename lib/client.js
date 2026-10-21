window.__ModuleLoader__.load({
  id: 'dsh-compact',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const STATUS_ENDPOINT = '/api/dsh-compact/status'
    const COMPACT_ENDPOINT = '/api/dsh-compact/compact-now'
    const CONFIG_ENDPOINT = '/api/dsh-compact/config'
    let currentSessionId = ''

    const css = [
      '.dshc-card{border:1px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:12px;padding:16px;display:grid;gap:14px;max-width:760px}',
      '.dshc-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}',
      '.dshc-title{font-size:16px;font-weight:650}',
      '.dshc-desc,.dshc-hint{font-size:12px;line-height:18px;opacity:.7;margin:4px 0 0}',
      '.dshc-row{display:flex;justify-content:space-between;align-items:center;gap:20px}',
      '.dshc-field{display:grid;gap:3px;min-width:0}',
      '.dshc-control{min-width:170px}',
      '.dshc-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:inherit;border-radius:8px;padding:7px 13px;cursor:pointer}',
      '.dshc-btn:disabled{opacity:.5;cursor:default}',
      '.dshc-status{font-size:12px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3)}',
      '.dshc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dshc-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#16803a)}',
      '.dshc-json{width:100%;min-height:88px;resize:vertical;font:12px/1.5 ui-monospace,monospace;box-sizing:border-box}',
      // 官方插件清单按 Loader entry 展示。下面这些是 dsh-compact 的实现
      // 细节或被 Web profile 停用的上游占位行；产品层只展示 compact。
      '[data-plugin-entry="compaction-basic"],[data-plugin-entry$=":compaction-basic"],' +
        '[data-plugin-entry="command-compact"],[data-plugin-entry$=":command-compact"],' +
        '[data-plugin-entry="tool-result-pruner"],[data-plugin-entry$=":tool-result-pruner"],' +
        '[data-plugin-entry="compact-agent"],[data-plugin-entry$=":compact-agent"]{display:none!important}',
    ].join('')

    function ensureCss() {
      const existing = document.querySelector('style[data-plugin-css="dsh-compact/client.css"]')
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-compact/client.css'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // The composer dock is session-scoped, so it is the surface that knows the
    // conversation the card is about. Host routes fall back to the newest root
    // agent when no session id is supplied.
    function SessionCapture(props) {
      React.useEffect(() => {
        if (props.sessionId) currentSessionId = props.sessionId
        return () => {
          if (currentSessionId === props.sessionId) currentSessionId = ''
        }
      }, [props.sessionId])
      return null
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'dshc-row' },
        h('span', { className: 'dshc-field' },
          h('span', null, label),
          h('small', { className: 'dshc-hint' }, hint),
        ),
        h('span', { className: 'dshc-control' }, children),
      )
    }

    async function readJson(response) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    function CompactCard() {
      const [config, setConfig] = React.useState(null)
      const [writable, setWritable] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [policiesText, setPoliciesText] = React.useState('[]')

      React.useEffect(() => {
        let active = true
        fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
          .then(readJson)
          .then((body) => {
            if (!active) return
            setConfig(body.config ?? {})
            setWritable(body.writable === true)
            setPoliciesText(JSON.stringify(body.config?.modelPolicies ?? [], null, 2))
          })
          .catch((error) => { if (active) setMessage({ ok: false, text: `读取配置失败：${error?.message ?? String(error)}` }) })
        return () => { active = false }
      }, [])

      React.useEffect(() => {
        let active = true
        const poll = () => {
          const query = currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : ''
          fetch(`${STATUS_ENDPOINT}${query}`, { cache: 'no-store' })
            .then(readJson)
            .then((next) => { if (active) setStatus(next) })
            .catch(() => { if (active) setStatus({ unavailable: true }) })
        }
        poll()
        const timer = setInterval(poll, 2000)
        return () => { active = false; clearInterval(timer) }
      }, [])

      const save = async (patch) => {
        setMessage(null)
        try {
          const body = await readJson(await fetch(CONFIG_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          }))
          setConfig(body.config ?? {})
          setPoliciesText(JSON.stringify(body.config?.modelPolicies ?? [], null, 2))
        } catch (error) {
          setMessage({ ok: false, text: error?.message ?? String(error) })
          throw error
        }
      }

      const compactNow = async () => {
        setBusy(true)
        setMessage(null)
        try {
          const body = await readJson(await fetch(COMPACT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(currentSessionId ? { sessionId: currentSessionId } : {}),
          }))
          if (body.status) setStatus(body.status)
          setMessage({
            ok: true,
            text: body.compacted ? '压缩已完成并持久化。' : '当前没有可安全压缩的旧历史。',
          })
        } catch (error) {
          setMessage({ ok: false, text: error?.message ?? String(error) })
        } finally {
          setBusy(false)
        }
      }

      const savePolicies = () => {
        try {
          const parsed = JSON.parse(policiesText)
          if (!Array.isArray(parsed)) throw new Error('模型策略必须是 JSON 数组')
          save({ modelPolicies: parsed }).catch(() => {})
        } catch (error) {
          setMessage({ ok: false, text: error?.message ?? String(error) })
        }
      }

      const value = config ?? {}
      const stateText = status?.unavailable
        ? 'Host 不可用'
        : status?.engineActive === false
        ? '当前 preset 未启用'
        : status?.state ?? '读取中'

      return h('div', { className: 'dshc-card', 'data-testid': 'dsh-compact-settings' },
        h('div', { className: 'dshc-head' },
          h('div', null,
            h('div', { className: 'dshc-title' }, '上下文自动压缩'),
            h('p', { className: 'dshc-desc' }, '在模型请求前按真实 Token 压力压缩；溢出时最多恢复并重试一次，不向输入框发送 /compact。'),
          ),
          h('span', { className: 'dshc-status' }, stateText),
        ),
        h(Field, { label: '启用自动压缩', hint: '关闭后不执行请求前压缩或溢出恢复；手动压缩仍可用。' },
          h('input', {
            type: 'checkbox',
            checked: value.enabled !== false,
            disabled: !writable,
            onChange: (event) => save({ enabled: event.target.checked }).catch(() => {}),
          }),
        ),
        h(Field, { label: '触发阈值', hint: `${Math.round((value.thresholdRatio ?? 0.75) * 100)}%` },
          h('input', {
            type: 'range', min: 0.5, max: 0.95, step: 0.01,
            value: value.thresholdRatio ?? 0.75, disabled: !writable,
            onChange: (event) => save({ thresholdRatio: Number(event.target.value) }).catch(() => {}),
          }),
        ),
        h(Field, { label: '保留近期上下文', hint: `${Math.round((value.retainRatio ?? 0.2) * 100)}%，必须低于触发阈值。` },
          h('input', {
            type: 'range', min: 0.05, max: 0.5, step: 0.01,
            value: value.retainRatio ?? 0.2, disabled: !writable,
            onChange: (event) => save({ retainRatio: Number(event.target.value) }).catch(() => {}),
          }),
        ),
        h(Field, { label: '溢出自动恢复', hint: '收到 CONTEXT_WINDOW_EXCEEDED 后压缩并重试原请求。' },
          h('input', {
            type: 'checkbox',
            checked: value.recoverOnOverflow !== false,
            disabled: !writable,
            onChange: (event) => save({ recoverOnOverflow: event.target.checked }).catch(() => {}),
          }),
        ),
        h(Field, { label: '溢出重试次数', hint: '为防止循环，只允许 0 或 1。' },
          h('select', {
            value: value.maxOverflowRetries ?? 1,
            disabled: !writable,
            onChange: (event) => save({ maxOverflowRetries: Number(event.target.value) }).catch(() => {}),
          },
          h('option', { value: 0 }, '0（关闭）'),
          h('option', { value: 1 }, '1（推荐）')),
        ),
        h('div', { className: 'dshc-field' },
          h('span', null, 'provider/model 专属策略'),
          h('small', { className: 'dshc-hint' }, 'JSON 数组；每项至少包含 provider 和 model，可覆盖 enabled、thresholdRatio、retainRatio、recoverOnOverflow、maxOverflowRetries。'),
          h('textarea', {
            className: 'dshc-json',
            value: policiesText,
            disabled: !writable,
            onChange: (event) => setPoliciesText(event.target.value),
          }),
          h('div', null,
            h('button', { type: 'button', className: 'dshc-btn', disabled: !writable, onClick: savePolicies }, '保存模型策略'),
          ),
        ),
        h('div', { className: 'dshc-row' },
          h('button', {
            type: 'button',
            className: 'dshc-btn',
            disabled: busy || status?.engineActive === false || status?.unavailable === true,
            onClick: compactNow,
          }, busy ? '正在压缩…' : '立即压缩当前对话'),
          message ? h('span', { className: message.ok ? 'dshc-ok' : 'dshc-error', role: 'status' }, message.text) : null,
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ensureCss(), 'dsh-compact: styles')
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'dsh-compact',
        order: 28,
        label: () => '上下文压缩',
      }, CompactCard))
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-compact-session-capture',
        order: 91,
      }, SessionCapture))
    }

    return {
      name: 'dsh-compact',
      inject: ['slots'],
      apply,
    }
  },
})
