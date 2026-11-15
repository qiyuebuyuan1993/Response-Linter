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

// Exact text-field snapshots. Memory/plugin metadata is deliberately excluded.
export function snapshotMessage(message) {
  const hasSwipe = Array.isArray(message?.swipes) && Number.isInteger(message.swipe_id)
    && message.swipe_id >= 0 && message.swipe_id < message.swipes.length;
  return {
    mes: message?.mes, hasExtra: !!message?.extra,
    hasDisplay: Object.prototype.hasOwnProperty.call(message?.extra || {}, 'display_text'),
    display: message?.extra?.display_text, swipeId: message?.swipe_id,
    swipes: message?.swipes, hasSwipe,
    swipe: hasSwipe ? message.swipes[message.swipe_id] : undefined,
  };
}

export function sameMessageState(message, state) {
  if (!message || !state) return false;
  const current = snapshotMessage(message);
  return ['mes', 'hasDisplay', 'display', 'swipeId', 'swipes', 'hasSwipe', 'swipe']
    .every(key => Object.is(current[key], state[key]));
}

export function chatIdentity(ctx) {
  try { return ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null; } catch { return null; }
}

let generationEpoch = 0;
let activeGeneration = null;
let navigationBlocked = null;
export function currentGenerationEpoch() { return generationEpoch; }
export function noteGenerationStarted() {
  generationEpoch++;
  const ctx = getFreshContext();
  activeGeneration = { chat: ctx?.chat, chatId: chatIdentity(ctx) };
}
export function noteGenerationEnded() { activeGeneration = null; }
export function noteNavigation() {
  generationEpoch++;
  activeGeneration = null;
  const ctx = getFreshContext();
  navigationBlocked = { chat: ctx?.chat, chatId: chatIdentity(ctx) };
}
export function noteFinalMessage() { navigationBlocked = null; }
export function hasValidSwipe(message) {
  return !Array.isArray(message?.swipes) || (Number.isInteger(message.swipe_id)
    && message.swipe_id >= 0 && message.swipe_id < message.swipes.length);
}
export function isAutoRepairReady(ctx, message) {
  return hasValidSwipe(message) && !isStreamingContext(ctx) &&
    !(navigationBlocked?.chat === ctx?.chat && navigationBlocked?.chatId === chatIdentity(ctx));
}
export function captureAutoTarget(ctx, message) {
  return { chat: ctx?.chat, chatId: chatIdentity(ctx), message,
    length: ctx?.chat?.length, tail: ctx?.chat?.at(-1), epoch: generationEpoch };
}
export function isCurrentAutoTarget(target, ctx = getFreshContext()) {
  return !!target && target.chat === ctx?.chat && target.chatId === chatIdentity(ctx)
    && target.epoch === generationEpoch && target.length === ctx?.chat?.length
    && target.tail === ctx?.chat?.at(-1) && target.message === target.tail;
}

/**
 * 当前是否正在流式生成。宿主 getContext() 暴露 streamingProcessor；
 * 只要处理器仍存在且未标记完成，就视为流未结束，不写入消息。
 */
export function isStreamingContext(ctx) {
  if (activeGeneration?.chat && activeGeneration.chat === ctx?.chat && activeGeneration.chatId === chatIdentity(ctx)) return true;
  const processor = ctx?.streamingProcessor;
  if (!processor) return false;
  if (processor.isFinished === true || processor.isStopped === true) return false;
  return true;
}
