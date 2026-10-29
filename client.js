/**
 * dsh-plugin-codex-link 的设置页（浏览器端）。
 *
 * 这是一个 client plugin bundle：外壳通过 `window.__ModuleLoader__.load` 加载，
 * factory 收到一个 `require`（其中包含 React），返回模块导出。页面注册到
 * `settings.section` 插槽，也就是「设置」窗口左侧的导航面板。
 *
 * 页面通过 `/.dsh-codex-link` 路由与宿主半边通信：
 *   GET  /state     全局状态（当前方式、默认会话、Codex 版本/连接）
 *   GET  /sessions  可选会话列表
 *   POST /mode      切换操作方式
 *   POST /bind      设置默认会话
 *
 * 整份文件是一个立即执行函数：外壳每次重建都会重新执行这个 classic script，
 * 顶层 `const`/`let` 重声明会直接报错，函数作用域是唯一安全的形式。
 */

(function () {
  const PREFIX = '/.dsh-codex-link'
  const SECTION_ID = 'dsh-plugin-codex-link'

  /** 把页面自身的异常报给宿主（写进 boot 日志），不作为页面失败的原因。 */
  function reportFailure(scope, error) {
    try {
      const payload = JSON.stringify({
        scope,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : '',
      })
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(`${PREFIX}/client-error`, new Blob([payload], { type: 'application/json' }))
        return
      }
      void fetch(`${PREFIX}/client-error`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    } catch {
      /* 上报失败不能影响页面 */
    }
  }

  window.__ModuleLoader__.load({
    id: SECTION_ID,
    factory: (require) => {
      const React = require('react')
      const h = React.createElement

      const copy = {
        nav: 'Codex 联动',
        title: 'Codex 联动',
        intro: '在这里选择 DSH 操作 Codex 的方式，以及默认使用的 Codex 会话。微信、桌面端等所有渠道共用这份设置。',
        modeTitle: '操作方式',
        modeHint: '改完立即生效。',
        workspaceTitle: '工作区',
        workspaceHint: 'Codex 项目和会话所在目录。留空/自动时优先用当前 DSH 会话目录，其次用户主目录。',
        workspaceChoose: '选择文件夹…',
        workspaceHome: '用主目录',
        workspaceAuto: '恢复自动',
        workspaceConfigured: '配置值',
        workspaceOverride: '设置页覆盖',
        workspaceSource: '来源',
        sourceConfig: '插件配置',
        sourceSettings: '设置页',
        sourceSession: '当前 DSH 会话目录',
        sourceHome: '用户主目录',
        sourceNone: '自动（未找到可用目录）',
        browseTitle: '选择工作区文件夹',
        browseUp: '上一层',
        browseSelect: '选这个目录',
        browseCancel: '取消',
        browseEmpty: '这个目录下没有子文件夹',
        statusTitle: '环境',
        appServer: 'Codex app-server',
        version: 'Codex 版本',
        workspace: '默认工作区',
        defaultThread: '默认会话',
        currentThread: '当前默认会话',
        noThread: '还没有默认会话',
        chooseThread: '选择默认会话',
        refresh: '刷新',
        listTitle: '可选会话',
        listEmpty: '没有找到会话（可以先在 Codex 里开一个对话，或在默认工作区新建）。',
        listAll: '显示全部工作区',
        listWorkspace: '只看默认工作区',
        useThread: '设为默认',
        binding: '已设为默认',
        loading: '读取中…',
        loadFailed: '读取失败',
        retry: '重试',
        saveFailed: '保存失败',
        updated: '已更新',
        modeDirect: '直控会话',
        modeSubagent: '子智能体',
        modeHybrid: '混合',
        directHint: 'DSH 直接驱动选中的 Codex 会话，实时读过程，可追加或中止。',
        subagentHint: 'codex_task 每次起独立进程执行任务，只回最终结果，不占用你正在看的会话。',
        hybridHint: '有默认会话时直控；没有绑定或任务要求隔离时走子智能体。',
      }

      function installStyles() {
        if (typeof document === 'undefined') return () => {}
        const id = 'dsh-codex-link-styles'
        if (document.getElementById(id) !== null) return () => {}
        const style = document.createElement('style')
        style.id = id
        style.textContent = [
          '.dsh-codex-link { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px 24px; }',
          '.dsh-codex-link h2 { font-size: 18px; margin: 0; }',
          '.dsh-codex-link .cx-intro { color: var(--dsh-text-secondary, #666); font-size: 13px; margin: 0; line-height: 1.6; }',
          '.dsh-codex-link .cx-card { border: 1px solid var(--dsh-border, #e5e5e5); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }',
          '.dsh-codex-link .cx-card-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }',
          '.dsh-codex-link .cx-hint { color: var(--dsh-text-secondary, #888); font-size: 12px; line-height: 1.5; }',
          '.dsh-codex-link .cx-mode { display: flex; gap: 8px; flex-wrap: wrap; }',
          '.dsh-codex-link .cx-mode-button { flex: 1 1 180px; text-align: left; border: 1px solid var(--dsh-border, #e5e5e5); background: transparent; border-radius: 10px; padding: 10px 12px; cursor: pointer; color: inherit; font: inherit; }',
          '.dsh-codex-link .cx-mode-button:hover { border-color: var(--dsh-accent, #7c5cff); }',
          '.dsh-codex-link .cx-mode-button.cx-active { border-color: var(--dsh-accent, #7c5cff); background: color-mix(in srgb, var(--dsh-accent, #7c5cff) 10%, transparent); }',
          '.dsh-codex-link .cx-mode-name { font-weight: 600; font-size: 13px; }',
          '.dsh-codex-link .cx-mode-desc { font-size: 12px; color: var(--dsh-text-secondary, #777); margin-top: 4px; line-height: 1.5; }',
          '.dsh-codex-link .cx-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }',
          '.dsh-codex-link .cx-value { color: var(--dsh-text-secondary, #777); font-size: 12px; word-break: break-all; text-align: right; }',
          '.dsh-codex-link .cx-actions { display: flex; gap: 8px; flex-wrap: wrap; }',
          '.dsh-codex-link button.cx-button { border: 1px solid var(--dsh-border, #ddd); background: transparent; border-radius: 8px; padding: 6px 10px; cursor: pointer; color: inherit; font: inherit; font-size: 12px; }',
          '.dsh-codex-link button.cx-button:hover { border-color: var(--dsh-accent, #7c5cff); }',
          '.dsh-codex-link button.cx-button.cx-primary { background: var(--dsh-accent, #7c5cff); border-color: transparent; color: #fff; }',
          '.dsh-codex-link .cx-session { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid var(--dsh-border, #efefef); font-size: 13px; }',
          '.dsh-codex-link .cx-session:first-of-type { border-top: none; }',
          '.dsh-codex-link .cx-session-title { font-weight: 500; }',
          '.dsh-codex-link .cx-session-meta { color: var(--dsh-text-secondary, #888); font-size: 11px; margin-top: 2px; }',
          '.dsh-codex-link .cx-error { color: #c0392b; font-size: 12px; }',
          '.dsh-codex-link .cx-ok { color: #16a34a; font-size: 12px; }',
          '.dsh-codex-link .cx-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 1000; }',
          '.dsh-codex-link .cx-modal { background: var(--dsh-surface, #fff); color: inherit; border-radius: 14px; padding: 16px; width: min(560px, 92vw); max-height: 72vh; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }',
          '.dsh-codex-link .cx-browse-path { font-size: 12px; color: var(--dsh-text-secondary, #666); word-break: break-all; background: var(--dsh-surface-muted, #f5f5f5); padding: 8px 10px; border-radius: 8px; }',
          '.dsh-codex-link .cx-browse-list { overflow: auto; border: 1px solid var(--dsh-border, #e5e5e5); border-radius: 8px; min-height: 120px; }',
          '.dsh-codex-link .cx-browse-entry { display: block; width: 100%; text-align: left; border: none; background: transparent; color: inherit; font: inherit; font-size: 13px; padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--dsh-border, #f0f0f0); }',
          '.dsh-codex-link .cx-browse-entry:hover { background: color-mix(in srgb, var(--dsh-accent, #7c5cff) 8%, transparent); }',
        ].join('\n')
        document.head.appendChild(style)
        return () => {
          try {
            style.remove()
          } catch {
            /* 已移除 */
          }
        }
      }

      /**
       * 请求宿主路由。
       *
       * @param {string} path 相对路径。
       * @param {{ method?: string, body?: any }} [options] 选项。
       * @returns {Promise<any>} JSON 结果。
       */
      async function call(path, options = {}) {
        const response = await fetch(`${PREFIX}${path}`, {
          method: options.method ?? 'GET',
          headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error ?? `HTTP ${String(response.status)}`)
        return data
      }

      /** 卡片容器。 */
      function Card(props) {
        return h(
          'section',
          { className: 'cx-card' },
          h('div', { className: 'cx-card-title' }, h('span', null, props.title), props.extra ?? null),
          props.hint ? h('p', { className: 'cx-hint' }, props.hint) : null,
          props.children,
        )
      }

      /** 设置页主体。 */
      function CodexLinkSettings() {
        const [state, setState] = React.useState(null)
        const [sessions, setSessions] = React.useState(null)
        const [showAll, setShowAll] = React.useState(false)
        const [busy, setBusy] = React.useState('')
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [browse, setBrowse] = React.useState(null)
        const [browseBusy, setBrowseBusy] = React.useState(false)

        /** 读取全局状态。 */
        async function loadState() {
          setError('')
          try {
            const next = await call('/state')
            setState(next)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
        }

        /** 读取可选会话。 */
        async function loadSessions(all) {
          try {
            const data = await call(`/sessions?limit=50${all ? '&all=1' : ''}`)
            setSessions(data)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
        }

        React.useEffect(() => {
          void loadState()
          void loadSessions(false)
        }, [])

        /** 切换操作方式。 */
        async function chooseMode(modeId) {
          setBusy('mode')
          setError('')
          try {
            const data = await call('/mode', { method: 'POST', body: { mode: modeId } })
            setState(data.state)
            setNotice(copy.updated)
          } catch (failure) {
            setError(`${copy.saveFailed}：${failure instanceof Error ? failure.message : String(failure)}`)
          } finally {
            setBusy('')
          }
        }

        /** 设为默认会话。 */
        async function chooseThread(threadId) {
          setBusy(threadId)
          setError('')
          try {
            const data = await call('/bind', { method: 'POST', body: { threadId } })
            setState(data.state)
            setNotice(copy.binding)
            await loadSessions(showAll)
          } catch (failure) {
            setError(`${copy.saveFailed}：${failure instanceof Error ? failure.message : String(failure)}`)
          } finally {
            setBusy('')
          }
        }

        /** 切换会话范围。 */
        async function toggleScope() {
          const next = !showAll
          setShowAll(next)
          await loadSessions(next)
        }

        /** 打开文件夹浏览器。 */
        async function openBrowse(path) {
          setBrowseBusy(true)
          setError('')
          try {
            const data = await call(`/fs?path=${encodeURIComponent(path ?? '')}`)
            setBrowse(data)
          } catch (failure) {
            setError(`${copy.loadFailed}：${failure instanceof Error ? failure.message : String(failure)}`)
          } finally {
            setBrowseBusy(false)
          }
        }

        /** 保存工作区；空串表示恢复自动。 */
        async function saveWorkspace(workspaceRoot) {
          setBusy('workspace')
          setError('')
          try {
            const data = await call('/workspace', { method: 'POST', body: { workspaceRoot } })
            setState(data.state)
            setBrowse(null)
            setNotice(copy.updated)
            await loadSessions(showAll)
          } catch (failure) {
            setError(`${copy.saveFailed}：${failure instanceof Error ? failure.message : String(failure)}`)
          } finally {
            setBusy('')
          }
        }

        /** 工作区来源的展示名。 */
        function sourceLabel(source) {
          if (source === 'config') return copy.sourceConfig
          if (source === 'settings') return copy.sourceSettings
          if (source === 'session') return copy.sourceSession
          if (source === 'home') return copy.sourceHome
          return copy.sourceNone
        }

        if (state === null) {
          return h(
            'div',
            { className: 'dsh-codex-link' },
            h('h2', null, copy.title),
            error === '' ? h('p', { className: 'cx-hint' }, copy.loading) : h('p', { className: 'cx-error' }, `${copy.loadFailed}：${error}`),
            error === '' ? null : h('button', { className: 'cx-button', onClick: loadState }, copy.retry),
          )
        }

        const modeDescriptions = {
          direct: copy.directHint,
          subagent: copy.subagentHint,
          hybrid: copy.hybridHint,
        }
        const binding = state.binding

        return h(
          'div',
          { className: 'dsh-codex-link' },
          h('h2', null, copy.title),
          h('p', { className: 'cx-intro' }, copy.intro),

          h(
            Card,
            { title: copy.modeTitle, hint: copy.modeHint },
            h(
              'div',
              { className: 'cx-mode' },
              state.modes.map((mode) =>
                h(
                  'button',
                  {
                    key: mode.id,
                    className: `cx-mode-button${mode.id === state.mode ? ' cx-active' : ''}`,
                    disabled: busy === 'mode' || mode.id === state.mode,
                    onClick: () => void chooseMode(mode.id),
                  },
                  h('div', { className: 'cx-mode-name' }, mode.label),
                  h('div', { className: 'cx-mode-desc' }, modeDescriptions[mode.id] ?? mode.description),
                ),
              ),
            ),
          ),

          h(
            Card,
            {
              title: copy.workspaceTitle,
              hint: copy.workspaceHint,
              extra: h(
                'div',
                { className: 'cx-actions' },
                h(
                  'button',
                  {
                    className: 'cx-button',
                    disabled: busy === 'workspace',
                    onClick: () => void openBrowse(state.workspace.override || state.workspace.effective),
                  },
                  copy.workspaceChoose,
                ),
                h(
                  'button',
                  {
                    className: 'cx-button',
                    disabled: busy === 'workspace',
                    onClick: () => void saveWorkspace(state.workspace.home),
                  },
                  copy.workspaceHome,
                ),
                state.workspace.override === ''
                  ? null
                  : h(
                      'button',
                      { className: 'cx-button', disabled: busy === 'workspace', onClick: () => void saveWorkspace('') },
                      copy.workspaceAuto,
                    ),
              ),
            },
            h('div', { className: 'cx-row' }, h('span', null, copy.workspace), h('span', { className: 'cx-value' }, state.workspace.effective || '（无）')),
            h('div', { className: 'cx-row' }, h('span', null, copy.workspaceSource), h('span', { className: 'cx-value' }, sourceLabel(state.workspace.source))),
            h(
              'div',
              { className: 'cx-row' },
              h('span', null, copy.workspaceOverride),
              h('span', { className: 'cx-value' }, state.workspace.override === '' ? '（无，跟随自动）' : state.workspace.override),
            ),
          ),

          h(
            Card,
            { title: copy.statusTitle },
            h('div', { className: 'cx-row' }, h('span', null, copy.appServer), h('span', { className: 'cx-value' }, state.appServer.state)),
            h(
              'div',
              { className: 'cx-row' },
              h('span', null, copy.version),
              h('span', { className: 'cx-value' }, state.binary === null ? state.binaryError ?? '未知' : `${state.binary.version || '未知版本'}`),
            ),
            h(
              'div',
              { className: 'cx-row' },
              h('span', null, copy.currentThread),
              h('span', { className: 'cx-value' }, binding === null ? copy.noThread : `${binding.title}（${String(binding.threadId).slice(0, 8)}）`),
            ),
          ),

          h(
            Card,
            {
              title: copy.listTitle,
              extra: h(
                'div',
                { className: 'cx-actions' },
                h('button', { className: 'cx-button', onClick: () => void loadSessions(showAll) }, copy.refresh),
                h('button', { className: 'cx-button', onClick: () => void toggleScope() }, showAll ? copy.listWorkspace : copy.listAll),
              ),
            },
            sessions === null
              ? h('p', { className: 'cx-hint' }, copy.loading)
              : sessions.sessions.length === 0
                ? h('p', { className: 'cx-hint' }, copy.listEmpty)
                : sessions.sessions.map((session) =>
                    h(
                      'div',
                      { className: 'cx-session', key: session.threadId },
                      h(
                        'div',
                        null,
                        h('div', { className: 'cx-session-title' }, session.title),
                        h(
                          'div',
                          { className: 'cx-session-meta' },
                          `${String(session.threadId).slice(0, 8)} · ${session.cwd || '未知目录'} · ${session.status ?? 'unknown'}`,
                        ),
                      ),
                      h(
                        'button',
                        {
                          className: `cx-button${session.threadId === (binding === null ? '' : binding.threadId) ? ' cx-primary' : ''}`,
                          disabled: busy === session.threadId,
                          onClick: () => void chooseThread(session.threadId),
                        },
                        session.threadId === (binding === null ? '' : binding.threadId) ? copy.binding : copy.useThread,
                      ),
                    ),
                  ),
          ),

          browse === null
            ? null
            : h(
                'div',
                {
                  className: 'cx-modal-backdrop',
                  onClick: (event) => {
                    if (event.target === event.currentTarget) setBrowse(null)
                  },
                },
                h(
                  'div',
                  { className: 'cx-modal' },
                  h('div', { className: 'cx-card-title' }, h('span', null, copy.browseTitle)),
                  h('div', { className: 'cx-browse-path' }, browse.path),
                  h(
                    'div',
                    { className: 'cx-actions' },
                    h(
                      'button',
                      {
                        className: 'cx-button',
                        disabled: browseBusy || browse.parent === null,
                        onClick: () => void openBrowse(browse.parent ?? ''),
                      },
                      copy.browseUp,
                    ),
                    (browse.drives ?? []).map((drive) =>
                      h('button', { key: drive, className: 'cx-button', onClick: () => void openBrowse(drive) }, drive),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'cx-browse-list' },
                    browse.error
                      ? h('p', { className: 'cx-error' }, browse.error)
                      : browse.entries.length === 0
                        ? h('p', { className: 'cx-hint' }, copy.browseEmpty)
                        : browse.entries.map((entry) =>
                            h(
                              'button',
                              {
                                key: entry.path,
                                className: 'cx-browse-entry',
                                onClick: () => void openBrowse(entry.path),
                              },
                              `📁 ${entry.name}`,
                            ),
                          ),
                  ),
                  h(
                    'div',
                    { className: 'cx-actions' },
                    h(
                      'button',
                      {
                        className: 'cx-button cx-primary',
                        disabled: busy === 'workspace',
                        onClick: () => void saveWorkspace(browse.path),
                      },
                      copy.browseSelect,
                    ),
                    h('button', { className: 'cx-button', onClick: () => setBrowse(null) }, copy.browseCancel),
                  ),
                ),
              ),

          error === '' ? null : h('p', { className: 'cx-error' }, error),
          notice === '' ? null : h('p', { className: 'cx-ok' }, notice),
        )
      }

      const name = 'codexLinkSettings'
      const inject = ['slots']

      function apply(ctx) {
        ctx.effect(() => {
          const removeStyles = installStyles()
          const disposeSection = ctx.slots.inject('settings.section', () => {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'codex-link',
                order: 45,
                label: () => copy.nav,
                inject: () => ({}),
              },
              CodexLinkSettings,
            )
          })
          return () => {
            if (typeof disposeSection === 'function') disposeSection()
            removeStyles()
          }
        })
      }

      return { name, inject, apply }
    },
  })
})()
