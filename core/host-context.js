// Response Linter 宿主上下文访问
// 每次调用都重新取上下文，避免聊天切换、候选回复切换或流式状态读到旧引用。
// 优先使用 window.SillyTavern.getContext（TauriTavern / SillyTavern 实际暴露的宿主入口），
// 再回退到全局 getContext / window.getContext，便于测试与旧构建运行。

export function getFreshContext() {
  try {
    if (typeof window !== 'undefined' && typeof window.SillyTavern?.getContext === 'function') {
      return window.SillyTavern.getContext();
    }
  } catch {}
  try {
    if (typeof getContext === 'function') return getContext();
  } catch {}
  try {
    if (typeof window !== 'undefined' && typeof window.getContext === 'function') return window.getContext();
  } catch {}
  return null;
}

/**
 * 按宿主既有约定解析消息：先 id，再索引。
 * @param {Object|null} ctx
 * @param {string|number} messageId
 * @returns {{message: Object|null, index: number, resolvedId: string}}
 */
export function findMessage(ctx, messageId) {
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  const wanted = String(messageId);
  let index = chat.findIndex(message => message && String(message.id) === wanted);
  if (index < 0 && /^\d+$/.test(wanted)) {
    const candidate = Number.parseInt(wanted, 10);
    if (Number.isInteger(candidate) && candidate >= 0 && candidate < chat.length) index = candidate;
  }
  return {
    message: index >= 0 ? chat[index] : null,
    index,
    resolvedId: index >= 0 ? String(chat[index]?.id ?? index) : wanted,
  };
}

export function messageContent(message) {
  return message?.extra?.display_text ?? message?.mes ?? '';
}

export function messageSwipeId(message) {
  return Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
}

/**
 * 当前是否正在流式生成。宿主 getContext() 暴露 streamingProcessor；
 * 只要处理器仍存在且未标记完成，就视为流未结束，不写入消息。
 */
export function isStreamingContext(ctx) {
  const processor = ctx?.streamingProcessor;
  if (!processor) return false;
  if (processor.isFinished === true || processor.isStopped === true) return false;
  return true;
}
