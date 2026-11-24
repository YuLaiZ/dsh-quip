/**
 * 俏皮话的素材工具：事件折叠、脱敏与生成结果清洗。
 *
 * 「素材」是喂给生成模型的一轮上下文摘要：用户这轮的发言、助手输出的
 * 正文摘要、工具调用统计与轮次时长。全部来自已提交的 `session/event`
 * 流，不回读会话日志；工具**结果**永不进素材（最可能携带文件内容与
 * 环境输出），只有工具名与次数。
 */

/** 素材里各片段的截断长度（字）。 */
const USER_TEXT_LIMIT = 400
const ASSISTANT_TEXT_LIMIT = 600
const ASSISTANT_TEXT_PER_STEP_LIMIT = 300
/**
 * 思考过程的截断长度。思考是「模型绕了什么弯、犹豫了什么」的第一手材料，比正文更能
 * 让自评说得准，给得比正文宽；但它往往冗长且自言自语，仍要封顶以免素材被它淹没。
 */
const REASONING_TEXT_LIMIT = 800
const REASONING_TEXT_PER_STEP_LIMIT = 400

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
    userText: '',
    assistantText: '',
    reasoningText: '',
    toolCalls: 0,
    toolNames: [],
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
 * @returns {ReturnType<freshTurnMaterial>} 同一素材对象。
 */
export function foldEvent(material, event) {
  if (!event || typeof event.type !== 'string') return material
  const data = event.data ?? {}
  switch (event.type) {
    case 'turn/start':
      material.turn = data.turn ?? material.turn
      material.startedAt = typeof event.time === 'number' ? event.time : material.startedAt
      return material
    case 'user/message': {
      // 只收真人输入；runtime-context / goal 等注入不是「用户发言」，
      // 但 steer（用户中途插话）source.kind 是 'user'，会被一并收进来，合理。
      if (data.source && data.source.kind !== 'user') return material
      const text = redactSecrets(textOf(data.content)).trim()
      if (text === '') return material
      material.userText = material.userText === ''
        ? text.slice(0, USER_TEXT_LIMIT)
        : material.userText + '\n' + text.slice(0, USER_TEXT_LIMIT)
      return material
    }
    case 'assistant/message': {
      material.steps += 1
      // 锚点：记下这条回复在日志里的位置与 id，quip 的 record.after 指向它
      if (Number.isSafeInteger(event.seq)) material.lastAssistantSeq = event.seq
      if (typeof data.message?.id === 'string' && data.message.id !== '') {
        material.lastAssistantMessageId = data.message.id
      }
      const content = data.message?.content
      const text = redactSecrets(textOf(content)).trim()
      if (text !== '' && material.assistantText.length < ASSISTANT_TEXT_LIMIT) {
        const chunk = text.slice(0, ASSISTANT_TEXT_PER_STEP_LIMIT)
        material.assistantText = material.assistantText === ''
          ? chunk
          : material.assistantText + '\n' + chunk
        if (material.assistantText.length > ASSISTANT_TEXT_LIMIT) {
          material.assistantText = material.assistantText.slice(0, ASSISTANT_TEXT_LIMIT)
        }
      }
      // 思考过程：同样脱敏（它比正文更可能复述文件内容与凭据），按步与总量分别封顶
      const reasoning = redactSecrets(textOf(content, 'reasoning')).trim()
      if (reasoning !== '' && material.reasoningText.length < REASONING_TEXT_LIMIT) {
        const chunk = reasoning.slice(0, REASONING_TEXT_PER_STEP_LIMIT)
        material.reasoningText = material.reasoningText === ''
          ? chunk
          : material.reasoningText + '\n' + chunk
        if (material.reasoningText.length > REASONING_TEXT_LIMIT) {
          material.reasoningText = material.reasoningText.slice(0, REASONING_TEXT_LIMIT)
        }
      }
      return material
    }
    case 'tool/call': {
      material.toolCalls += 1
      const name = typeof data.name === 'string' ? data.name : ''
      if (name !== '' && !material.toolNames.includes(name)) {
        // 保留去重后的工具名清单，最多记 8 个
        if (material.toolNames.length < 8) material.toolNames.push(name)
      }
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
 * 素材是否值得生成：完全空轮（用户没说话且助手没输出）跳过。
 * @param {ReturnType<freshTurnMaterial>} material - 折叠后的素材。
 * @returns {boolean} 值得生成。
 */
export function materialWorthQuip(material) {
  return material.userText !== '' || material.assistantText !== ''
    || material.reasoningText !== '' || material.toolCalls > 0
}

/**
 * 把素材渲染成给生成模型的用户消息正文。
 * @param {ReturnType<freshTurnMaterial>} material - 折叠后的素材。
 * @param {{ includeReasoning?: boolean }} [options] - 是否带上思考过程。
 * @returns {string} 素材正文。
 */
export function renderMaterial(material, options = {}) {
  const lines = []
  lines.push(`【本轮用户发言摘要】\n${material.userText === '' ? '（无文本，可能是命令或附件触发）' : material.userText}`)
  lines.push(`【本轮助手输出摘要】\n${material.assistantText === '' ? '（无可见文本输出）' : material.assistantText}`)
  if (options.includeReasoning !== false) {
    lines.push(`【本轮助手思考过程摘录（模型内心的犹豫、绕路与自我纠正；自评时可以引用）】\n${material.reasoningText === '' ? '（本轮无思考过程）' : material.reasoningText}`)
  }
  const tools = material.toolCalls === 0
    ? '（未调用工具）'
    : `共 ${material.toolCalls} 次：${material.toolNames.join('、')}${material.toolCalls > material.toolNames.length ? ' 等' : ''}`
  lines.push(`【本轮工具使用】${tools}`)
  const seconds = material.startedAt > 0 ? Math.max(1, Math.round((Date.now() - material.startedAt) / 1000)) : 0
  lines.push(`【本轮耗时】约 ${seconds} 秒，${material.steps} 次模型步骤，结束原因 ${material.endedReason || 'completed'}`)
  lines.push('请依据以上素材，按系统指令输出一句话。')
  return lines.join('\n\n')
}

/**
 * 清洗生成模型的原始输出：去包裹引号与首尾空白，只取第一行。
 * **不截断**：完整展示是硬需求，请求层也不设 maxTokens（带思考的模型会被
 * 思考挤爆配额）；长度只靠系统提示里的 maxChars 约束，超了照常完整显示。
 * 只取第一行是格式清洗（系统提示要求不换行），不是长度截断。
 * @param {string} raw - 模型输出的拼接文本。
 * @returns {string} 清洗后的一句话；空串表示放弃。
 */
export function cleanQuipText(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (text === '') return ''
  // 只取第一行（规则说不换行，防御性处理），再去掉包裹整句的一对引号；
  // 「（叉腰）这波稳了」这类首部的动作描写括号不成对包裹整句，保留。
  const firstLine = text.split(/\r?\n/, 1)[0].trim()
  if (firstLine !== '') text = firstLine
  const wraps = [['「', '」'], ['『', '』'], ['（', '）'], ['“', '”'], ['"', '"'], ["'", "'"], ['(', ')']]
  for (const [open, close] of wraps) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(1, -1).trim()
      if (inner !== '') {
        text = inner
        break
      }
    }
  }
  return text
}
