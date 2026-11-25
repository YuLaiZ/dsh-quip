/**
 * dsh-quip（俏皮话）Client 半边。
 *
 * 两个注册点：
 * 1. `conversation.chat.turnTail`（list 槽，replaceRisk none）：每个完成的
 *    Turn 末尾渲染一句俏皮话小字。组件收 session 作用域标准 prop
 *    `sessionId` 与 owner props `{ turn, seq }`。
 * 2. `settings.section`（list 槽）：设置页「俏皮话」卡片——开关、风格、
 *    模型（下拉列出已注册 provider/model）与自定义提示词；经
 *    /api/quip/v1/status 读取、/api/quip/v1/config 写回。卡片下方是生成记录
 *    面板：紧凑列表（时间 / 所属文件 / 模型 / 来源 / 文本 / 用量），展开看
 *    定位坐标与素材；「打开记录文件夹」经宿主的 session Remote 在系统文件
 *    管理器里打开记录目录（省略 action = 直接进入目录，不是在父目录选中）。
 *
 * 数据层：每会话一份 store——首挂 fetch 全量，EventSource 订阅增量；
 * SSE 因认证或网络失败进入 CLOSED 时降级为 8s 轮询。连接与订阅随引用
 * 计数释放；会话数据缓存保留到页面刷新（host 内存态本来就随重启清空）。
 */

window.__ModuleLoader__.load({
  id: '@yulaiz/dsh-quip',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /**
     * 宿主的 UI 原子组件（可选依赖）：能 require 到就用宿主同一套折叠行 / 按钮，风格与设置页其他卡片一致；
     * require 不到（例如 jsdom 测试）退回本包自绘的等价结构。
     */
    let primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch { primitives = null }
    const DisclosureRow = primitives?.DisclosureRow ?? null
    const HostButton = primitives?.Button ?? null
    /** 统一按钮工厂：优先宿主 Button，否则原生 button.qp-btn；调用方只关心 props 与文字。 */
    const makeButton = (props, label) => (HostButton !== null
      ? h(HostButton, { variant: 'outline', size: 'sm', ...props }, label)
      : h('button', { type: 'button', className: 'qp-btn', ...props }, label))

    /** API 前缀（与 host 半边一致）。 */
    const API = '/api/quip/v1'
    /** SSE 失败后的轮询间隔。 */
    const POLL_FALLBACK_MS = 8000
    /**
     * 等待态窗口：轮次结束时刻距今在此之内、且该轮还没有俏皮话时，显示占位。
     * 超过窗口仍没有（host 关闭、空轮跳过、生成失败且无兜底）就不再占位。
     * 翻历史时旧轮次早已超出窗口，不会闪占位。
     */
    const WAIT_WINDOW_MS = 15_000
    /** turnTail 槽登记 id：新 id 与宿主条目并列。 */
    const TAIL_ID = 'dsh-quip'
    /** settings.section 槽登记 id（与 tail 分开，避免同 id 注册互相干扰；宿主插件页 order 15，本分区排其后）。 */
    const SECTION_ID = 'dsh-quip-settings'
    const SECTION_ORDER = 40

    // ---- 文案（zh 为主，en 兜底；meta 部分由 locale/*.json 提供） ----
    const DICTS = {
      zh: {
        settingsNav: '俏皮话',
        settingsHint: '每轮回复完成后，用独立模型生成一句自评小字，显示在该轮回复末尾。',
        waiting: '正在想一句俏皮话…',
        enabled: '启用俏皮话',
        style: '风格',
        styles: { playful: '俏皮', hype: '夸夸', roast: '毒舌自嘲', calm: '冷静自评', custom: '自定义' },
        customPrompt: '自定义提示词',
        customPromptHint: '描述这句话的人设与语气，仅在风格为「自定义」时生效。',
        includeReasoning: '素材带上思考过程',
        includeReasoningHint: '把模型内心的犹豫与绕路（脱敏后）也交给自评模型，生成更贴切；关闭可省输入 token。',
        followSession: '跟随会话模型',
        followSessionHint: '用本会话当前选中的模型生成（含思考等级），与你在输入框上方选的保持一致。',
        model: '生成模型',
        modelAuto: '自动（第一个已注册）',
        modelFixedHint: '固定模型：不跟随会话时使用。',
        reasoning: '思考等级',
        reasoningAuto: '自动（该模型最低等级）',
        reasoningNone: '（该模型无思考等级）',
        reload: '刷新模型列表',
        save: '保存',
        saved: '已保存',
        saveFailed: '保存失败：{msg}',
        loading: '读取中…',
        loadFailed: '读取失败，稍后重试',
        noProviders: '没有已注册的模型 provider',
        genToggle: '查看生成记录',
        genFolderHint: '记录按 500 条一个文件永久保存在记录目录，不再自动清理；要删历史直接删文件。',
        genOpenFolder: '打开记录文件夹',
        genOpened: '已打开',
        genRefresh: '刷新',
        genOpenFailed: '无法打开文件夹',
        genEmpty: '还没有生成记录（每轮回复后出现）',
        genTurn: '第 {n} 轮',
        genSource: { model: '模型', fallback: '兜底池', skip: '素材不足跳过', error: '失败', empty: '模型无输出', timeout: '超时', aborted: '中止', 'no-provider': '无 provider' },
        genTokens: '{in} 进 / {out} 出',
        genDuration: '{ms} 毫秒',
        genMetaTokens: '{in}/{out}',
        genMetaDuration: '{s}s',
        genDurationLabel: '耗时',
        genText: '文本',
        genMaterial: '素材（已脱敏）',
        genPrompt: '系统提示词',
        genUsage: 'token 用量',
        genUsageFull: '{in} 进 / {out} 出 / 共 {total}',
        genError: '错误',
        genFile: '记录文件',
        genShowMore: '载入更多',
        genTurnLabel: '轮次',
        genSeq: '会话日志 seq',
        genStep: '虚拟步 step',
        genMsgId: 'message.id',
        genAfterSeq: '所评论回复的 seq',
        genNotPersisted: '未写入会话日志',
        genLocate: '复制定位命令',
        genCopied: '已复制',
        genCopyFailed: '复制失败，请手动选中复制',
      },
      en: {
        settingsNav: 'Quip footer',
        settingsHint: 'After each completed reply, generates a one-line self-review with an independent model call, shown at the end of that turn.',
        waiting: 'Thinking of a one-liner…',
        enabled: 'Enable quips',
        style: 'Style',
        styles: { playful: 'Playful', hype: 'Hyping', roast: 'Self-roasting', calm: 'Calm', custom: 'Custom' },
        customPrompt: 'Custom prompt',
        customPromptHint: 'Describe the persona and tone; used only when the style is Custom.',
        includeReasoning: 'Include reasoning in material',
        includeReasoningHint: 'Feed the model\'s own hesitations and detours (redacted) to the self-review call for a sharper line; off saves input tokens.',
        followSession: 'Follow the session model',
        followSessionHint: 'Generate with the model the session currently uses (including its reasoning effort), matching what you picked above the composer.',
        model: 'Generation model',
        modelAuto: 'Auto (first registered)',
        modelFixedHint: 'Fixed model, used only when not following the session.',
        reasoning: 'Reasoning effort',
        reasoningAuto: 'Auto (lowest level the model offers)',
        reasoningNone: '(this model has no reasoning levels)',
        reload: 'Reload model list',
        save: 'Save',
        saved: 'Saved',
        saveFailed: 'Save failed: {msg}',
        loading: 'Loading…',
        loadFailed: 'Load failed; retrying later',
        noProviders: 'No registered model provider',
        genToggle: 'View generation log',
        genFolderHint: 'Records are kept forever, 500 per file, in the records folder; nothing is pruned automatically—delete files to clear history.',
        genOpenFolder: 'Open records folder',
        genOpened: 'Opened',
        genRefresh: 'Refresh',
        genOpenFailed: 'Could not open the folder',
        genEmpty: 'No generations yet (they appear after each reply)',
        genTurn: 'Turn {n}',
        genSource: { model: 'model', fallback: 'fallback pool', skip: 'skipped (thin material)', error: 'failed', empty: 'model returned nothing', timeout: 'timed out', aborted: 'aborted', 'no-provider': 'no provider' },
        genTokens: '{in} in / {out} out',
        genDuration: '{ms} ms',
        genMetaTokens: '{in}/{out}',
        genMetaDuration: '{s}s',
        genDurationLabel: 'Duration',
        genText: 'Text',
        genMaterial: 'Material (redacted)',
        genPrompt: 'System prompt',
        genUsage: 'Token usage',
        genUsageFull: '{in} in / {out} out / {total} total',
        genError: 'Error',
        genFile: 'Record file',
        genShowMore: 'Load more',
        genTurnLabel: 'Turn',
        genSeq: 'Session log seq',
        genStep: 'Virtual step',
        genMsgId: 'message.id',
        genAfterSeq: 'seq of the reviewed reply',
        genNotPersisted: 'not persisted',
        genLocate: 'Copy locate command',
        genCopied: 'Copied',
        genCopyFailed: 'Copy failed; select and copy manually',
      },
    }

    /** 当前语言（宿主在 <html lang> 上维护；en 兜底）。 */
    function detectLocale() {
      const lang = typeof document !== 'undefined' && document.documentElement
        ? (document.documentElement.lang || '').toLowerCase()
        : ''
      return lang.startsWith('zh') ? 'zh' : 'en'
    }

    function tr(key, params) {
      const dict = DICTS[detectLocale()] ?? DICTS.zh
      let text = dict[key] ?? DICTS.en[key] ?? key
      if (params) {
        for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
      }
      return text
    }

    // 生成来源 / 模型调用结局的文案（QuipTail 悬停明细与生成记录面板共用）
    const sourceLabel = (source) => (tr('genSource')[source] ?? source ?? '')
    // outcome 说明模型调用本身怎么了（与文本来源 source 不同）：额度耗尽/超时/无输出
    const outcomeLabel = (outcome) => (tr('genSource')[outcome] ?? outcome ?? '')

    // ---- 样式（仅主题 token；类名前缀 qp-） ----
    /**
     * 回复末尾的俏皮话：按「旁白」处理——左侧一条品牌色细竖线 + 小一号的灰字，
     * 不斜体（中文斜体是伪斜体，发歪）、不放图标（竖线本身就是标记）。
     * 竖线颜色取主题 brand 色再降透明度，浅色 / 深色主题下都只做提示不抢正文。
     */
    const TAIL_CSS = [
      '.qp-tail{position:relative;display:flex;align-items:baseline;gap:8px;max-width:100%;margin:4px 0 8px;',
      'padding:1px 0 1px 10px;color:var(--dsw-alias-label-tertiary);',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));',
      'animation:qp-in .45s ease both}',
      '.qp-tail::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;border-radius:1px;',
      'background:var(--dsw-alias-brand-primary, var(--dsw-alias-label-tertiary));opacity:.38}',
      '@keyframes qp-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.qp-tail{animation:none}}',
      '.qp-tail-text{min-width:0;overflow-wrap:anywhere}',
      // 等待态：轮次刚结束、俏皮话还在生成时的占位（三个跳动的点）
      '.qp-wait{display:inline-flex;align-items:center;gap:3px;height:12px}',
      '.qp-wait i{display:block;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);',
      'animation:qp-wait-bounce 1.2s ease-in-out infinite}',
      '.qp-wait i:nth-child(2){animation-delay:.15s}',
      '.qp-wait i:nth-child(3){animation-delay:.3s}',
      '@keyframes qp-wait-bounce{0%,80%,100%{opacity:.25;transform:none}40%{opacity:1;transform:translateY(-2px)}}',
      '@media (prefers-reduced-motion: reduce){.qp-wait i{animation:none;opacity:.5}}',
    ].join('')

    /** 「查看生成记录」标题行前的列表图标（宿主没有 DisclosureRow 时用）。 */
    const GEN_LIST_ICON = h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' },
      h('path', { d: 'M5.5 4h8M5.5 8h8M5.5 12h8' }), h('circle', { cx: 2.8, cy: 4, r: 0.6, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 2.8, cy: 8, r: 0.6, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 2.8, cy: 12, r: 0.6, fill: 'currentColor', stroke: 'none' }))
    /** 折叠行右侧的 chevron（展开时旋转 180°）。 */
    const CHEVRON_ICON = h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M2.5 4.5 6 8l3.5-3.5' }))

    const SECTION_CSS = [
      '.qp-settings{display:flex;flex-direction:column;gap:16px;padding:8px 0;',
      'font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      // 面板自身做容器查询的锚：列表按面板宽度（不是视口）决定列的取舍
      '.qp-card{container-type:inline-size;display:flex;flex-direction:column;gap:4px;padding:12px 16px;',
      'border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);',
      'background:var(--dsw-alias-settings-card-fill)}',
      '.qp-row{display:flex;align-items:center;justify-content:space-between;gap:16px;',
      'min-height:40px;padding:6px 0;box-sizing:border-box}',
      // 标签区弹性吸收宽度，控件区不收缩：否则控件区被挤到内部换行（刷新按钮掉到下一行）
      '.qp-row-copy{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}',
      '.qp-row--top{align-items:flex-start}',
      '.qp-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.qp-divider{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.qp-row input[type="checkbox"]{flex:0 0 auto;width:16px;height:16px;margin:0;',
      'accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.qp-select,.qp-text{box-sizing:border-box;width:200px;max-width:100%;height:28px;padding:0 8px;',
      'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;}',
      '.qp-select:disabled,.qp-text:disabled{opacity:.55;cursor:default}',
      '.qp-select--narrow{width:130px}',
      '.qp-area{box-sizing:border-box;width:100%;min-height:64px;padding:6px 8px;resize:vertical;',
      'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit}',
      '.qp-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex:none;white-space:nowrap}',
      '.qp-btn{display:inline-flex;justify-content:center;align-items:center;box-sizing:border-box;',
      'height:28px;min-width:58px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);',
      'font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer}',
      '.qp-btn[disabled]{opacity:.55;cursor:default}',
      '@media (hover: hover){.qp-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}}',
      '.qp-select:focus-visible,.qp-text:focus-visible,.qp-area:focus-visible,.qp-btn:focus-visible,.qp-gen-head:focus-visible{',
      'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:2px}',
      '.qp-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      // 折叠标题行（宿主没有 DisclosureRow 时的自绘版）：整行可点，右侧按钮 + chevron
      '.qp-gen-head{display:flex;justify-content:space-between;align-items:center;gap:12px;',
      'min-height:36px;padding:4px 0;cursor:pointer;border-radius:var(--dsw-radius-sm)}',
      '.qp-gen-head-title{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:22px}',
      '.qp-gen-head-title svg{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.qp-gen-head-actions{display:flex;align-items:center;gap:8px}',
      '.qp-gen-chevron{display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform .2s ease}',
      '.qp-gen-chevron[data-open="true"]{transform:rotate(180deg)}',
      '@media (prefers-reduced-motion: reduce){.qp-gen-chevron{transition:none}}',
      '.qp-gen-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0 0 8px}',
      // 折叠标题行与内容之间的呼吸空间（宿主 DisclosureRow 与自绘版共用）
      '.qp-gen-body{margin-top:6px}',
      // 列表：一张紧凑的表，行之间用分割线而不是每条一个卡片
      '.qp-gen-list{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-sm);overflow:hidden}',
      '.qp-gen-item{border-bottom:0.5px solid var(--dsw-alias-border-l3)}',
      '.qp-gen-item:last-child{border-bottom:0}',
      '.qp-gen-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0;padding:5px 10px;',
      'border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;',
      'font-size:12px;line-height:20px;text-align:left;cursor:pointer}',
      '.qp-gen-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.qp-gen-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:-2px}',
      '.qp-gen-when{flex:none;width:38px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.qp-gen-file{flex:0 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-quaternary, var(--dsw-alias-label-tertiary));',
      'font-family:var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px}',
      // 模型列收缩优先级最高（flex-shrink 3）：窄面板下先把空间让给文件名和文本
      '.qp-gen-model{flex:0 3 150px;min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.qp-gen-badge{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);',
      'font-size:11px;line-height:16px}',
      '.qp-gen-badge[data-src="model"]{color:var(--dsw-alias-label-secondary)}',
      '.qp-gen-badge[data-outcome]{color:var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary));',
      'background:var(--dsw-alias-state-warning-fill, var(--dsw-alias-interactive-bg-hover))}',
      '.qp-gen-text{flex:1 1 80px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 窄面板（web 版设置弹窗约 560px）：模型列让位给文本；完整路由仍在 hover title 与详情里
      '@container (max-width: 640px){.qp-gen-model{display:none}}',
      '.qp-gen-meta{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;',
      'font-variant-numeric:tabular-nums;white-space:nowrap}',
      // 详情：缩进 + 顶部分割线，坐标走两列网格，多行内容走带标签的块
      '.qp-gen-detail{display:flex;flex-direction:column;gap:10px;padding:10px 12px 12px 20px;',
      'border-top:0.5px solid var(--dsw-alias-border-l3)}',
      '.qp-gen-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 14px;margin:0;',
      'font-size:12px;line-height:20px}',
      '.qp-gen-kv dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:20px}',
      '.qp-gen-kv dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;',
      'font-variant-numeric:tabular-nums}',
      '.qp-gen-kv dd.qp-mono{font-family:var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11.5px}',
      '.qp-gen-block-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}',
      '.qp-gen-main{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.qp-gen-detail pre{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsh-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);',
      'font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}',
      '.qp-gen-more{display:flex;justify-content:center;padding:6px 0 8px}',
      '.qp-gen-locate{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.qp-gen-cmd{flex:1 1 240px;min-width:0;margin:0;padding:6px 10px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);',
      'font-family:var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);',
      'font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}',
    ].join('')

    // ---- 每会话数据 store ----
    /**
     * @typedef {{ v?: number, turn: number, text: string, style?: string, source?: string, provider?: string | null, model?: string | null, usage?: Record<string, number> | null, time?: number }} QuipEntry
     * @typedef {{ refCount: number, es: EventSource | null, pollTimer: number | null,
     *            entries: Map<number, QuipEntry>, listeners: Set<() => void>,
     *            snapshotVersion: number }} SessionStore
     */
    const stores = new Map()

    /** JSON fetch 小工具（同源带凭证）。 */
    async function apiGet(path) {
      const res = await fetch(path, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** 全量拉取并合并进 store。 */
    async function refresh(sessionId, store) {
      try {
        const data = await apiGet(`${API}/quips?session=${encodeURIComponent(sessionId)}`)
        if (!Array.isArray(data?.quips)) return
        let changed = false
        for (const entry of data.quips) {
          if (entry && typeof entry.turn === 'number' && typeof entry.text === 'string'
            && store.entries.get(entry.turn)?.text !== entry.text) {
            store.entries.set(entry.turn, entry)
            changed = true
          }
        }
        if (changed) notify(store)
      } catch { /* 下次轮询/订阅重试 */ }
    }

    /** 通知全部订阅者。 */
    function notify(store) {
      store.snapshotVersion += 1
      for (const listener of [...store.listeners]) listener()
    }

    /** 打开 SSE；失败到 CLOSED 时安排轮询兜底。 */
    function openStream(sessionId, store) {
      if (store.es !== null || typeof EventSource !== 'function') {
        if (store.es === null) startPolling(sessionId, store)
        return
      }
      const es = new EventSource(`${API}/watch?session=${encodeURIComponent(sessionId)}`)
      store.es = es
      es.onmessage = (message) => {
        try {
          const entry = JSON.parse(message.data)
          if (entry && typeof entry.turn === 'number' && typeof entry.text === 'string') {
            store.entries.set(entry.turn, entry)
            notify(store)
          }
        } catch { /* 跳过坏帧 */ }
      }
      es.onerror = () => {
        // CLOSED（服务不可达/认证失败）时 EventSource 不再自动重连
        if (es.readyState === EventSource.CLOSED) {
          if (store.es === es) {
            store.es = null
            es.close()
            startPolling(sessionId, store)
          }
        }
      }
    }

    /** 轮询兜底（SSE 不可用时）。 */
    function startPolling(sessionId, store) {
      if (store.pollTimer !== null) return
      store.pollTimer = setInterval(() => {
        void refresh(sessionId, store)
      }, POLL_FALLBACK_MS)
    }

    /** 引用计数获取 store。 */
    function acquireStore(sessionId) {
      let store = stores.get(sessionId)
      if (store === undefined) {
        store = { refCount: 0, es: null, pollTimer: null, entries: new Map(), listeners: new Set(), snapshotVersion: 0 }
        stores.set(sessionId, store)
      }
      store.refCount += 1
      if (store.refCount === 1) {
        void refresh(sessionId, store)
        openStream(sessionId, store)
      }
      return store
    }

    /** 释放引用；归零后关闭连接（缓存数据保留）。 */
    function releaseStore(sessionId, store) {
      store.refCount -= 1
      if (store.refCount > 0) return
      if (store.es !== null) {
        const es = store.es
        store.es = null
        es.close()
      }
      if (store.pollTimer !== null) {
        clearInterval(store.pollTimer)
        store.pollTimer = null
      }
    }

    /**
     * 订阅一句俏皮话。
     * store 的 acquire/release 必须在 effect 里成对执行：`useMemo` 在渲染期运行，
     * StrictMode 下会重复调用，放在那里会让引用计数只增不减（SSE 连接永不释放）。
     * 这里 effect 先于 `useSyncExternalStore` 的订阅 effect 执行（同一组件内按
     * 声明顺序），所以订阅时 store 已就绪。
     */
    function useQuip(sessionId, turn) {
      const valid = sessionId !== null && turn >= 0
      const storeRef = React.useRef(null)
      React.useEffect(() => {
        if (!valid) return
        const store = acquireStore(sessionId)
        storeRef.current = store
        return () => {
          releaseStore(sessionId, store)
          storeRef.current = null
        }
      }, [valid, sessionId])
      const subscribe = React.useCallback((listener) => {
        const store = storeRef.current
        if (store === null) return () => {}
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }, [])
      const getSnapshot = React.useCallback(
        () => (storeRef.current === null ? null : storeRef.current.entries.get(turn) ?? null),
        [turn],
      )
      const quip = React.useSyncExternalStore(subscribe, getSnapshot, () => null)
      return valid ? quip : null
    }

    // ---- turnTail 渲染 ----
    /**
     * 从 owner props 解析轮次号。
     * ui-chat 的 TurnTailOwnerProps.turn 是 TurnLocation 对象（{ turn, start,
     * end, status, steps, data }），其中的 `turn` 才是轮次号；兼容直接传数字
     * 的形态，其余视为无效坐标返回 -1。
     */
    function turnOf(props) {
      const raw = props.turn
      if (typeof raw === 'number') return raw
      if (raw !== null && typeof raw === 'object' && typeof raw.turn === 'number') return raw.turn
      return -1
    }

    /**
     * 等待态：轮次刚结束、俏皮话还没到时渲染占位。
     * 只在「轮次结束时刻距今 < WAIT_WINDOW_MS」时占位，并定时在窗口到期后自动消失；
     * 翻历史时旧轮次不满足条件，直接不渲染。
     * @param {number} endedAt - 轮次结束时刻（turn/end 事件的 time）。
     * @returns {boolean} 是否仍在等待窗口内。
     */
    function useWaiting(endedAt) {
      const eligible = Number.isFinite(endedAt) && Date.now() - endedAt < WAIT_WINDOW_MS
      const [expired, setExpired] = React.useState(false)
      React.useEffect(() => {
        if (!eligible) return
        const remain = WAIT_WINDOW_MS - (Date.now() - endedAt)
        const timer = setTimeout(() => setExpired(true), Math.max(0, remain))
        return () => clearTimeout(timer)
      }, [eligible, endedAt])
      return eligible && !expired
    }

    /** turnTail 条目组件：props 收 session 作用域 sessionId 与 owner { turn, seq }。 */
    function QuipTail(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      const turn = turnOf(props)
      const quip = useQuip(sessionId, turn)
      const waiting = useWaiting(turn >= 0 ? props.turn?.end?.time : NaN)
      if (quip === null) {
        return waiting
          ? h('div', { className: 'qp-tail', 'data-quip-turn': turn, 'data-quip-waiting': 'true', 'aria-label': tr('waiting') },
              h('span', { className: 'qp-wait', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')))
          : null
      }
      // 悬停明细（Web 版原生 title 生效；桌面版静默无提示）
      const usage = quip.usage
      const detailBits = []
      // 路由优先取原生 message.source（与 assistant/message 同构），兼容 request / 扁平字段
      const routeOf = (entry) => {
        const src = entry?.message?.source
        if (src !== null && src !== undefined && typeof src === 'object') {
          return {
            provider: src.provider ?? entry?.request?.provider ?? null,
            model: src.model ?? entry?.request?.model ?? null,
          }
        }
        return {
          provider: entry?.provider ?? entry?.request?.provider ?? null,
          model: entry?.model ?? entry?.request?.model ?? null,
        }
      }
      // 兜底句不是模型生成的（record 里 message.source.kind 是插件自有 kind，不挂模型）：
      // 明细先标来源，再显示尝试过的路由——用户要能一眼看出「这句是兜底」以及「当时想用哪个模型」
      const quipSource = quip.source ?? quip.plugin?.source ?? null
      if (quipSource !== null && quipSource !== 'model') detailBits.push(sourceLabel(quipSource))
      const quipRoute = routeOf(quip)
      if (quipRoute.model !== null) {
        const label = (quipRoute.provider === null ? '' : quipRoute.provider + '/') + quipRoute.model
        detailBits.push(label)
      }
      if (usage && typeof usage === 'object') {
        detailBits.push(`${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out`)
      }
      if (Number.isFinite(quip.time)) {
        const date = new Date(quip.time)
        detailBits.push(Number.isFinite(date.getTime())
          ? `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${clockOf(quip.time)}`
          : '')
      }
      return h('div', {
        className: 'qp-tail',
        'data-quip-turn': turn,
        'data-quip-source': quip.source ?? '',
        title: detailBits.filter(Boolean).join(' · ') || undefined,
      },
        h('span', { className: 'qp-tail-text' }, String(quip.text ?? '')))
    }

    // ---- 设置卡 ----
    /** 读取一次状态。 */
    function loadStatus() {
      return apiGet(`${API}/status`)
    }

    /** HH:MM 时间格式。 */
    function clockOf(ts) {
      const date = new Date(ts)
      return Number.isFinite(date.getTime())
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : ''
    }

    /** 紧凑键值网格里的一行（dt + dd）；空值不渲染。 */
    function genKv(label, value, mono = false) {
      if (value === null || value === undefined || value === '') return null
      return [
        h('dt', { key: label + ':dt' }, label),
        h('dd', { key: label + ':dd', className: mono ? 'qp-mono' : undefined }, typeof value === 'string' ? value : JSON.stringify(value)),
      ]
    }

    /** 多行内容块：小标签 + 可滚动的 pre。 */
    function genBlock(label, value) {
      if (value === null || value === undefined || value === '') return null
      return h('div', { className: 'qp-gen-block' },
        h('div', { className: 'qp-gen-block-label' }, label),
        h('pre', null, typeof value === 'string' ? value : JSON.stringify(value, null, 2)))
    }

    /** 行内显示的文件名：去掉 generations- 前缀与 .jsonl 后缀，只留时间戳（完整名在 title 与详情里）。 */
    function fileLabel(file) {
      return String(file).replace(/^generations-/, '').replace(/\.jsonl$/, '')
    }

    /**
     * 一条生成记录 → 会话文件里那一行的定位命令（zstd + jq）。
     * 有 recordSeq 时按 seq 精确命中；写入失败没有 seq 时按 turn 兜底（每轮只写一条 record）。
     * @param {Record<string, any>} record - 生成记录。
     * @returns {string} 命令文本；缺 session 时为空串。
     */
    function locateCommandOf(record) {
      const session = String(record?.session ?? '')
      if (session === '') return ''
      const seq = record.recordSeq
      const filter = Number.isInteger(seq)
        ? `.seq==${seq}`
        : `.type=="plugin:dsh-quip/quip" and .data.turn==${Number(record.turn)}`
      return `f=$(find ~/.dsh/sessions -type d -name '${session}' -exec find {} -name 'session.v*.jsonl.zstd' \\;); `
        + `zstd -dc "$f" | jq 'select(${filter})'`
    }

    /**
     * 生成记录面板：紧凑列表（时间 / 所属文件 / 模型 / 来源 / 文本 / 用量），展开看定位坐标与素材。
     * 折叠时零请求；展开后按需分页。「打开记录文件夹」走宿主的 session Remote——
     * 省略 action 是直接进入目录（不是在父目录里选中它）。
     * @param {{ status?: object, remote?: object | null }} props - 设置卡已拉取的 status（含 dataDir）与会话 Remote。
     */
    function GenLogPanel(props) {
      const remote = props.remote ?? null
      const dataDir = typeof props.status?.dataDir === 'string' && props.status.dataDir !== '' ? props.status.dataDir : null
      const [open, setOpen] = React.useState(false)
      const [records, setRecords] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [limit, setLimit] = React.useState(20)
      const [expanded, setExpanded] = React.useState('')
      /** 复制定位命令后的按钮态：`${key}:ok` 已复制 / `${key}:fail` 复制失败；空串为空闲。 */
      const [copyState, setCopyState] = React.useState('')
      /** 打开文件夹按钮态：'' 空闲 / opening / ok / fail。 */
      const [folderState, setFolderState] = React.useState('')
      /** 宿主是否能打开本地路径（Remote 探测）。 */
      const [canOpen, setCanOpen] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        const probe = remote?.session?.canOpenWorkspacePath
        if (typeof probe !== 'function') { setCanOpen(false); return () => { alive = false } }
        Promise.resolve()
          .then(() => probe.call(remote.session))
          .then((result) => { if (alive) setCanOpen(result?.ok === true && result?.value === true) })
          .catch(() => { if (alive) setCanOpen(false) })
        return () => { alive = false }
      }, [remote])

      const reload = React.useCallback((nextLimit) => {
        setFailed(false)
        apiGet(`${API}/generations?limit=${nextLimit}`)
          .then((data) => { setRecords(Array.isArray(data?.generations) ? data.generations : []) })
          .catch(() => setFailed(true))
      }, [])

      React.useEffect(() => {
        if (open && records === null) reload(limit)
      }, [open, records, limit, reload])

      const onToggle = () => {
        setOpen((current) => !current)
      }
      const onMore = () => {
        const nextLimit = limit + 20
        setLimit(nextLimit)
        reload(nextLimit)
      }
      const openable = canOpen && dataDir !== null && folderState !== 'opening'
      const onOpenFolder = async () => {
        if (!openable) return
        setFolderState('opening')
        try {
          const opened = await remote.session.openWorkspacePath({ path: dataDir })
          if (opened?.ok !== true) throw new Error('open failed')
          setFolderState('ok')
          setTimeout(() => setFolderState(''), 1500)
        } catch {
          setFolderState('fail')
          setTimeout(() => setFolderState(''), 3000)
        }
      }

      const onCopyLocate = (key, command) => {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          setCopyState(`${key}:fail`)
          return
        }
        clipboard.writeText(command)
          .then(() => {
            setCopyState(`${key}:ok`)
            setTimeout(() => { setCopyState('') }, 1500)
          })
          .catch(() => setCopyState(`${key}:fail`))
      }

      const itemOf = (record) => {
        const key = `${record.ts}:${record.turn}`
        const usage = record.usage
        // 行内用缩短格式（1153/892 · 6.5s）把宽度让给文本；完整格式进 hover title
        const metaBits = []
        const metaTitle = []
        if (usage !== null && typeof usage === 'object') {
          metaBits.push(tr('genMetaTokens', { in: usage.inputTokens ?? 0, out: usage.outputTokens ?? 0 }))
          metaTitle.push(tr('genTokens', { in: usage.inputTokens ?? 0, out: usage.outputTokens ?? 0 }))
        }
        if (Number.isFinite(record.durationMs) && record.durationMs > 0) {
          metaBits.push(tr('genMetaDuration', { s: (record.durationMs / 1000).toFixed(1) }))
          metaTitle.push(tr('genDuration', { ms: record.durationMs }))
        }
        const isOpen = expanded === key
        const command = locateCommandOf(record)
        const buttonState = copyState === `${key}:ok` ? 'ok' : copyState === `${key}:fail` ? 'fail' : ''
        const filePath = dataDir !== null && typeof record.file === 'string' ? `${dataDir}/${record.file}` : (record.file ?? null)
        const outcomeBadge = record.outcome !== undefined && record.outcome !== 'ok'
          ? h('span', { className: 'qp-gen-badge', 'data-outcome': record.outcome, title: String(record.error ?? '') }, outcomeLabel(record.outcome))
          : null
        return h('div', { className: 'qp-gen-item', key },
          h('button', {
            type: 'button', className: 'qp-gen-row', 'aria-expanded': isOpen ? 'true' : 'false',
            // 整行 hover 显示路由：模型列在窄面板下隐藏时仍能看到
            title: (String(record.provider ?? '?') + '/' + String(record.model ?? '')).replace(/\/$/, ''),
            onClick: () => { setExpanded(isOpen ? '' : key) },
          },
            h('span', { className: 'qp-gen-when' }, clockOf(record.ts)),
            record.file ? h('span', { className: 'qp-gen-file', title: filePath ?? record.file }, fileLabel(record.file)) : null,
            h('span', { className: 'qp-gen-model', title: `${record.provider ?? ''}/${record.model ?? ''}` },
              `${record.provider ?? record.request?.provider ?? '?'}/${record.model ?? record.request?.model ?? ''}`.replace(/\/$/, '')),
            h('span', { className: 'qp-gen-badge', 'data-src': record.source ?? '' }, sourceLabel(record.source)),
            outcomeBadge,
            h('span', { className: 'qp-gen-text' }, String(record.text ?? record.error ?? '')),
            metaBits.length > 0 ? h('span', { className: 'qp-gen-meta', title: metaTitle.join(' · ') }, metaBits.join(' · ')) : null),
          isOpen ? h('div', { className: 'qp-gen-detail' },
            // 主内容：用户最终看到的那句（模型原文或兜底句），来源看行内徽章
            h('div', { className: 'qp-gen-block' },
              h('div', { className: 'qp-gen-block-label' }, tr('genText')),
              h('div', { className: 'qp-gen-main' }, String(record.text ?? ''))),
            // 定位坐标：紧凑两列网格
            h('dl', { className: 'qp-gen-kv' },
              genKv(tr('genTurnLabel'), record.turn),
              genKv(tr('genSeq'), record.recordSeq ?? tr('genNotPersisted')),
              genKv(tr('genStep'), record.step),
              genKv(tr('genMsgId'), record.messageId, true),
              genKv(tr('genAfterSeq'), record.afterSeq),
              genKv(tr('genFile'), filePath, true),
              genKv(tr('genUsage'), usage && typeof usage === 'object'
                ? tr('genUsageFull', { in: usage.inputTokens ?? 0, out: usage.outputTokens ?? 0, total: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) })
                : null),
              genKv(tr('genDurationLabel'), Number.isFinite(record.durationMs) ? tr('genDuration', { ms: record.durationMs }) : null),
              genKv('session', record.session, true)),
            genBlock(tr('genMaterial'), record.material),
            genBlock(tr('genPrompt'), record.systemPrompt),
            genBlock(tr('genError'), record.error),
            command !== ''
              ? h('div', { className: 'qp-gen-locate' },
                  h('code', { className: 'qp-gen-cmd' }, command),
                  h('button', {
                    type: 'button', className: 'qp-btn', 'data-copy': buttonState,
                    onClick: () => { onCopyLocate(key, command) },
                  }, buttonState === 'ok' ? tr('genCopied') : buttonState === 'fail' ? tr('genCopyFailed') : tr('genLocate')))
              : null)
          : null)
      }

      const folderButton = makeButton({
        disabled: !openable,
        title: dataDir ?? tr('genOpenFailed'),
        onClick: () => { void onOpenFolder() },
      }, folderState === 'opening' ? '…' : folderState === 'ok' ? tr('genOpened') : folderState === 'fail' ? tr('genOpenFailed') : tr('genOpenFolder'))

      const body = open
          ? (failed
              ? h('span', { className: 'qp-gen-hint' }, tr('loadFailed'))
              : records === null
                ? h('span', { className: 'qp-gen-hint' }, tr('loading'))
                : records.length === 0
                  ? h('span', { className: 'qp-gen-hint' }, tr('genEmpty'))
                  : h('div', { className: 'qp-gen-list' },
                      records.map(itemOf),
                      records.length >= limit
                        ? h('div', { className: 'qp-gen-more' },
                            h('button', { type: 'button', className: 'qp-btn', onClick: onMore }, tr('genShowMore')))
                        : null))
          : null
      // 展开后说明保留策略：不会自动清理，想删就去目录里删文件
      const hint = open && records !== null && records.length > 0 ? h('div', { className: 'qp-gen-hint' }, tr('genFolderHint')) : null

      // 标题行：有宿主的 DisclosureRow 就用它（和对话里「思考过程」折叠行同一套交互与样式），
      // 整行可点、折叠时图标 hover 出 chevron、展开时 chevron 朝上；没有则用本包自绘的等价结构
      if (DisclosureRow !== null) {
        return h('div', { className: 'qp-card' },
          h(DisclosureRow, {
            icon: GEN_LIST_ICON, title: tr('genToggle'), open, expandable: true, expandOnRowClick: true,
            onToggle, headerAccessory: open ? folderButton : null,
          }, body === null && hint === null ? null : h('div', { className: 'qp-gen-body' }, body, hint)))
      }
      return h('div', { className: 'qp-card' },
        h('div', {
          className: 'qp-gen-head', role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
          'aria-label': tr('genToggle'),
          onClick: onToggle,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } },
        },
          h('span', { className: 'qp-gen-head-title' }, GEN_LIST_ICON, tr('genToggle')),
          // 右侧按钮组不冒泡到标题行，否则点「打开记录文件夹」会顺手把面板收起
          h('div', { className: 'qp-gen-head-actions', role: 'presentation', onClick: (event) => event.stopPropagation() },
            open ? folderButton : null,
            h('span', { className: 'qp-gen-chevron', 'data-open': open ? 'true' : undefined, 'aria-hidden': 'true' }, CHEVRON_ICON))),
        body === null && hint === null ? null : h('div', { className: 'qp-gen-body' }, body, hint))
    }
    /** 设置卡组件。 */
    function QuipSettings(props) {
      const [status, setStatus] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [saveNote, setSaveNote] = React.useState('')

      const reload = React.useCallback(() => {
        setFailed(false)
        loadStatus().then((data) => {
          setStatus(data)
          setDraft({
            enabled: data?.config?.enabled !== false,
            style: data?.config?.style ?? 'playful',
            customPrompt: data?.config?.customPrompt ?? '',
            model: data?.config?.provider === 'auto' && data?.config?.model === 'auto'
              ? 'auto'
              : `${data?.config?.provider ?? ''}/${data?.config?.model ?? ''}`.replace(/\/$/, ''),
            reasoningEffort: data?.config?.reasoningEffort ?? 'auto',
            includeReasoning: data?.config?.includeReasoning !== false,
            followSessionModel: data?.config?.followSessionModel !== false,
          })
        }).catch(() => setFailed(true))
      }, [])
      React.useEffect(reload, [reload])

      if (draft === null) {
        return h('div', { className: 'qp-settings' },
          h('div', { className: 'qp-card' }, h('span', { className: 'qp-hint' },
            failed ? tr('loadFailed') : tr('loading'))))
      }

      const patch = (part) => setDraft((current) => ({ ...current, ...part }))
      const modelOptions = []
      /** provider/model → 该模型声明的思考等级（容错旧形态：纯字符串 id）。 */
      const effortsByModel = new Map()
      const providers = Array.isArray(status?.providers) ? status.providers : []
      for (const provider of providers) {
        for (const model of provider.models ?? []) {
          const entry = typeof model === 'object' && model !== null
            ? model
            : { id: String(model), name: String(model), efforts: [] }
          const value = `${provider.id}/${entry.id}`
          modelOptions.push({ value, label: `${provider.name ?? provider.id} · ${entry.name ?? entry.id}` })
          effortsByModel.set(value, Array.isArray(entry.efforts) ? entry.efforts : [])
        }
      }
      /** 选中模型（provider/model）的思考等级；auto 或未知模型时为 null。 */
      const selectedEfforts = effortsByModel.get(draft.model) ?? null

      const onSave = () => {
        const next = {
          enabled: draft.enabled,
          style: draft.style,
          customPrompt: draft.customPrompt,
          reasoningEffort: draft.reasoningEffort ?? 'auto',
          includeReasoning: draft.includeReasoning !== false,
          followSessionModel: draft.followSessionModel !== false,
        }
        if (draft.model === 'auto') {
          next.provider = 'auto'
          next.model = 'auto'
        } else if (draft.model.includes('/')) {
          const index = draft.model.indexOf('/')
          next.provider = draft.model.slice(0, index)
          next.model = draft.model.slice(index + 1)
        }
        setSaving(true)
        setSaveNote('')
        fetch(`${API}/config`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: next }),
        }).then(async (res) => {
          const body = await res.json().catch(() => null)
          if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
          setSaveNote(tr('saved'))
          reload()
        }).catch((error) => {
          setSaveNote(tr('saveFailed', { msg: error instanceof Error ? error.message : String(error) }))
        }).finally(() => setSaving(false))
      }

      const styleIds = Array.isArray(status?.styles) ? status.styles : ['playful', 'hype', 'roast', 'calm', 'custom']
      const styleSelect = h('select', {
        className: 'qp-select', value: draft.style, 'aria-label': tr('style'),
        onChange: (event) => patch({ style: event.target.value }),
      }, styleIds.map((id) => h('option', { key: id, value: id }, tr('styles')[id] ?? id)))

      const modelSelect = modelOptions.length === 0
        ? h('span', { className: 'qp-hint' }, tr('noProviders'))
        : h('select', {
          className: 'qp-select', value: draft.model, 'aria-label': tr('model'),
          onChange: (event) => {
            const value = event.target.value
            const efforts = effortsByModel.get(value) ?? []
            // 之前为别的模型选的等级在新模型上不存在：回到 auto，避免保存一个无效等级
            const keep = draft.reasoningEffort === 'auto' || efforts.some((effort) => effort.id === draft.reasoningEffort)
            patch(keep ? { model: value } : { model: value, reasoningEffort: 'auto' })
          },
        }, [
          h('option', { key: 'auto', value: 'auto' }, tr('modelAuto')),
          ...modelOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ])

      // 思考等级：与模型同一行；只在选中了具体模型且该模型声明了等级时出现，否则不占位
      const reasoningSelect = selectedEfforts !== null && selectedEfforts.length > 0
        ? h('select', {
            className: 'qp-select qp-select--narrow', value: draft.reasoningEffort ?? 'auto', 'aria-label': tr('reasoning'),
            title: tr('reasoning'),
            onChange: (event) => patch({ reasoningEffort: event.target.value }),
          }, [
            h('option', { key: 'auto', value: 'auto' }, tr('reasoningAuto')),
            ...selectedEfforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id)),
          ])
        : null
      const customRow = draft.style === 'custom'
        ? [
            h('div', { className: 'qp-divider', key: 'qp-custom-divider' }),
            h('div', { className: 'qp-row', key: 'qp-custom-row' },
              h('div', { className: 'qp-row-copy' },
                h('label', { htmlFor: 'qp-custom-prompt' }, tr('customPrompt')),
                h('span', { className: 'qp-hint' }, tr('customPromptHint'))),
              h('textarea', {
                id: 'qp-custom-prompt', className: 'qp-area', rows: 3,
                value: draft.customPrompt,
                onChange: (event) => patch({ customPrompt: event.target.value }),
              })),
          ]
        : []

      const saveButton = h('button', {
        type: 'button', className: 'qp-btn', disabled: saving, onClick: onSave,
      }, saving ? '…' : tr('save'))

      return h('div', { className: 'qp-settings' },
        h('style', null, SECTION_CSS),
        h('div', { className: 'qp-card' },
          h('div', { className: 'qp-row' },
            h('div', { className: 'qp-row-copy' },
              h('span', null, tr('settingsNav')),
              h('span', { className: 'qp-hint' }, tr('settingsHint'))),
            h('input', {
              type: 'checkbox', checked: draft.enabled,
              'aria-label': tr('enabled'),
              onChange: (event) => patch({ enabled: event.target.checked }),
            })),
          h('div', { className: 'qp-divider' }),
          h('div', { className: 'qp-row' }, h('span', null, tr('style')), styleSelect),
          // 跟随会话模型（默认）：用会话当前选中的模型生成，口径与用户看到的一致
          h('div', { className: 'qp-row' },
            h('div', { className: 'qp-row-copy' },
              h('span', null, tr('followSession')),
              h('span', { className: 'qp-hint' }, tr('followSessionHint'))),
            h('input', {
              type: 'checkbox', checked: draft.followSessionModel !== false,
              'aria-label': tr('followSession'),
              onChange: (event) => patch({ followSessionModel: event.target.checked }),
            })),
          // 固定模型行只在关闭跟随时出现（跟随时由会话决定，配置值不参与）
          draft.followSessionModel === false
            ? h('div', { className: 'qp-row qp-row--top' },
                h('div', { className: 'qp-row-copy' },
                  h('span', null, tr('model')),
                  h('span', { className: 'qp-hint' }, tr('modelFixedHint'))),
                h('div', { className: 'qp-actions' },
                  modelSelect,
                  reasoningSelect,
                  makeButton({ onClick: reload, title: tr('reload'), 'aria-label': tr('reload') }, tr('genRefresh'))))
            : null,
          h('div', { className: 'qp-divider' }),
          h('div', { className: 'qp-row' },
            h('div', { className: 'qp-row-copy' },
              h('span', null, tr('includeReasoning')),
              h('span', { className: 'qp-hint' }, tr('includeReasoningHint'))),
            h('input', {
              type: 'checkbox', checked: draft.includeReasoning !== false,
              'aria-label': tr('includeReasoning'),
              onChange: (event) => patch({ includeReasoning: event.target.checked }),
            })),
          ...customRow,
          h('div', { className: 'qp-divider' }),
          h('div', { className: 'qp-actions' },
            saveNote !== '' ? h('span', { className: 'qp-status', role: 'status' }, saveNote) : null,
            saveButton)),
        // 必须作为元素渲染而不是直接调用：GenLogPanel 自带 hooks，直接调用
        // 会让它的 hooks 挂进 QuipSettings 的渲染，loading 态提前 return 时
        // hooks 缺失 → 顺序违规 → 设置卡崩溃空白（0.2.2 修复）
        h(GenLogPanel, { status, remote: props.remote ?? null }))
    }

    return {
      // remote / remote.session：面板「打开记录文件夹」经宿主的 session Remote 打开本地目录
      inject: ['slots', 'remote', 'remote.session'],
      apply(ctx) {
        // 样式常驻（挂 document.head，随插件卸载移除），不随组件挂载/卸载
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-quip'
          tag.dataset.pluginCss = 'dsh-quip/tail'
          tag.textContent = TAIL_CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'dsh-quip: tail stylesheet')

        // 回复末尾的一句小字
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
          { name: 'conversation.chat.turnTail', id: TAIL_ID, order: 20, label: 'Quip' },
          QuipTail,
        ))

        // 设置页卡片（label 用 thunk，跟随活跃语言重读）
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => tr('settingsNav') },
          (slotProps) => h(QuipSettings, { ...slotProps, remote: ctx.remote }),
        ))
      },
    }
  },
})
