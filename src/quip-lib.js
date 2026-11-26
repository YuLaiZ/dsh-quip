/**
 * 俏皮话的素材工具：事件折叠与脱敏。
 *
 * 「素材」是喂给生成模型的一轮上下文：用户这轮的发言、助手的回复、工具调用统计与轮次时长。
 * 全部来自已提交的 `session/event` 流，不回读会话日志；工具**结果**永不进素材（最可能携带
 * 文件内容与环境输出），只有工具名与次数。
 *
 * 用户发言、回复正文、思考过程都**逐字原样**、不做任何字数截断（只去首尾空白，按脱敏开关
 * 做替换）。思考只取本轮第一条与最后一条非空的：是否带进素材由设置项 `includeReasoning`
 * 决定（渲染时决定），折叠时两条总是记下。
 */

/**
 * 脱敏：把疑似密钥 / token / 密码的片段替换为 `[redacted]` 再进素材。
 * 只做模式匹配，不尝试解码；宁可错杀（长 hex 串可能是普通哈希）。
 * @param {string} text - 原文。
 * @returns {string} 脱敏后的文本。
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text
    // sk-、ghp_、xox 等带前缀的 token
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[baprs]|AKIA|AIza)[A-Za-z0-9_\-]{16,}\b/g, '[redacted]')
    // Bearer <token>
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{16,}/gi, 'Bearer [redacted]')
    // 长十六进制（>=32）或长 base64 形态（>=40）
    .replace(/\b[a-fA-F0-9]{32,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted]')
    // key=value / key: value 形态的常见敏感键
    .replace(/\b(?:api[_-]?key|secret|token|passwd|password|authorization)\b\s*[=:]\s*\S+/gi, '$1=[redacted]')
}

/**
 * 从消息 content 块里提取指定类型的纯文本（默认可见正文；`'reasoning'` 取思考过程）。
 * @param {ReadonlyArray<{type: string, text?: string}> | undefined} content - 消息内容块。
 * @param {'text' | 'reasoning'} [kind] - 要提取的块类型。
 * @returns {string} 拼接文本。
 */
export function textOf(content, kind = 'text') {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === kind && typeof block.text === 'string') out += block.text
  }
  return out
}

/** 一轮素材的折叠态（host 侧按 sessionId 持有，turn 结束取走）。 */
export function freshTurnMaterial() {
  return {
    turn: -1,
    /** 本轮最后一个 step 号（来自 step/end）；没有 step 事件时为 0。 */
    step: 0,
    startedAt: 0,
    /** 本轮真人发言全文；多条（含用户中途插话 steer）用换行连接。 */
    userText: '',
    /** 各步可见正文，按时间：{ step, text }。step 来自 assistant/message 的 data.step，没有则为 null。 */
    assistantSteps: [],
    /** 本轮第一条 / 最后一条 trim 后非空的思考：{ step, text }；没有则为 null。 */
    firstReasoning: null,
    lastReasoning: null,
    toolCalls: 0,
    /** 工具名 → 调用次数，按首次出现的顺序（Map 保持插入序）。 */
    toolCounts: new Map(),
    steps: 0,
    endedReason: '',
    /**
     * 本轮最后一条 assistant/message 的日志 seq 与 message.id：quip 在它之后生成，
     * record 用这两个值把每条俏皮话钉回它所评论的那条实际回复上。没有则为 null。
     */
    lastAssistantSeq: null,
    lastAssistantMessageId: null,
    /** turn/end 的日志 seq（quip 的直接前驱事件）；没有则为 null。 */
    turnEndSeq: null,
  }
}

/**
 * 把一个已提交事件折叠进素材（纯函数式追加，返回同一对象便于链式调用）。
 * 未知事件被忽略；`assistant/message` 的 interrupted 前缀同样计入（那是
 * 实际发出去的可见内容）。
 * @param {ReturnType<freshTurnMaterial>} material - 素材累积器。
 * @param {{ type: string, time?: number, data: any }} event - 会话事件。
 * @param {{ redact?: boolean }} [options] - 脱敏开关，折叠时读取，对之后折叠的事件生效；未传按开处理。
 * @returns {ReturnType<freshTurnMaterial>} 同一素材对象。
 */
export function foldEvent(material, event, options = {}) {
  if (!event || typeof event.type !== 'string') return material
  const data = event.data ?? {}
  const clean = options.redact === false ? (text) => text : redactSecrets
  switch (event.type) {
    case 'turn/start':
      material.turn = data.turn ?? material.turn
      material.startedAt = typeof event.time === 'number' ? event.time : material.startedAt
      return material
    case 'user/message': {
      // 只收真人输入；runtime-context / goal 等注入不是「用户发言」，
      // 但 steer（用户中途插话）source.kind 是 'user'，会被一并收进来，合理。
      if (data.source && data.source.kind !== 'user') return material
      const text = clean(textOf(data.content)).trim()
      if (text === '') return material
      material.userText = material.userText === '' ? text : material.userText + '\n' + text
      return material
    }
    case 'assistant/message': {
      material.steps += 1
      // 锚点：记下这条回复在日志里的位置与 id，quip 的 record.after 指向它
      if (Number.isSafeInteger(event.seq)) material.lastAssistantSeq = event.seq
      if (typeof data.message?.id === 'string' && data.message.id !== '') {
        material.lastAssistantMessageId = data.message.id
      }
      const step = Number.isSafeInteger(data.step) ? data.step : null
      // 正文全文原样（只去首尾空白）
      const text = clean(textOf(data.message?.content)).trim()
      if (text !== '') material.assistantSteps.push({ step, text })
      // 思考：同样按开关脱敏（它比正文更可能复述文件内容与凭据）；只记第一条与最后一条非空的
      const reasoning = clean(textOf(data.message?.content, 'reasoning')).trim()
      if (reasoning !== '') {
        const entry = { step, text: reasoning }
        // 第一条只在还没有时记；最后一条每条都覆盖
        if (material.firstReasoning === null) material.firstReasoning = entry
        material.lastReasoning = entry
      }
      return material
    }
    case 'tool/call': {
      material.toolCalls += 1
      const name = typeof data.name === 'string' ? data.name : ''
      if (name !== '') material.toolCounts.set(name, (material.toolCounts.get(name) ?? 0) + 1)
      return material
    }
    case 'step/end':
      // 记录最后一个 step 号：quip 在 turn/end 后触发，record 用它 + 1 作槽位（见 index.js）
      if (typeof data.step === 'number' && data.step > material.step) material.step = data.step
      return material
    case 'turn/end':
      material.endedReason = data.reason?.kind ?? ''
      if (Number.isSafeInteger(event.seq)) material.turnEndSeq = event.seq
      return material
    default:
      return material
  }
}

/**
 * 素材是否值得生成：完全空轮（用户没说话、助手没输出、没调工具）跳过。
 * @param {ReturnType<freshTurnMaterial>} material - 折叠后的素材。
 * @returns {boolean} 值得生成。
 */
export function materialWorthQuip(material) {
  return material.userText !== '' || material.assistantSteps.length > 0
    || material.firstReasoning !== null || material.toolCalls > 0
}

/** 「第 N 步：正文」；没有步号时只有正文。 */
function stepLabel(step, text) {
  return step === null ? text : `第 ${step} 步：${text}`
}

/**
 * 把素材渲染成给生成模型的用户消息正文。各段逐字原样，不做任何截断。
 * @param {ReturnType<freshTurnMaterial>} material - 折叠后的素材。
 * @param {{ includeReasoning?: boolean }} [options] - 是否带上思考过程（首尾两条全文）。
 * @returns {string} 素材正文。
 */
export function renderMaterial(material, options = {}) {
  const lines = []
  lines.push(`【本轮用户发言】\n${material.userText === '' ? '（无文本，可能是命令或附件触发）' : material.userText}`)
  const reply = material.assistantSteps.length === 0
    ? '（无可见文本输出）'
    : material.assistantSteps.map((item) => stepLabel(item.step, item.text)).join('\n')
  lines.push(`【本轮助手回复】\n${reply}`)
  const tools = material.toolCalls === 0
    ? '（未调用工具）'
    : `共 ${material.toolCalls} 次：${[...material.toolCounts].map(([name, count]) => `${name}×${count}`).join('、')}`
  lines.push(`【本轮工具使用】${tools}`)
  const seconds = material.startedAt > 0 ? Math.max(1, Math.round((Date.now() - material.startedAt) / 1000)) : 0
  lines.push(`【本轮耗时】约 ${seconds} 秒，${material.steps} 次模型步骤，结束原因 ${material.endedReason || 'completed'}`)
  if (options.includeReasoning !== false) {
    const first = material.firstReasoning
    const last = material.lastReasoning
    const body = first === null
      ? '（本轮无思考过程）'
      : (first === last ? stepLabel(first.step, first.text) : `${stepLabel(first.step, first.text)}\n${stepLabel(last.step, last.text)}`)
    lines.push(`【本轮助手思考过程（模型内心的犹豫、绕路与自我纠正；自评时可以引用）】\n${body}`)
  }
  lines.push('请依据以上素材，按系统指令输出一句话。')
  return lines.join('\n\n')
}
