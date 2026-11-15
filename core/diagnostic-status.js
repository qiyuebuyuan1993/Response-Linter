import { getFreshContext, chatIdentity, isStreamingContext, currentGenerationEpoch } from './host-context.js';
import { messageModifier } from './message-modifier.js';
import { fixCoordinator } from './fix-coordinator.js';
import { messageHandler } from './message-handler.js';
import { getDiagnostics } from './diagnostics.js';

let lastChat, lastId, session = 0;
export function diagnosticSnapshot(settings = {}, version = '1.4.13') {
  const ctx = getFreshContext();
  if (ctx?.chat !== lastChat || chatIdentity(ctx) !== lastId) {
    lastChat = ctx?.chat; lastId = chatIdentity(ctx); session++;
  }
  const index = (ctx?.chat?.length || 0) - 1;
  const message = ctx?.chat?.[index];
  const coordinator = globalThis[Symbol.for('st.message-write-coordinator.v1')];
  let owner = 'none';
  for (const candidate of ['response-linter', 'veridis-rewrite', 'veridis-save']) {
    if (ctx?.chat && coordinator?.isOwner?.(ctx.chat, candidate)) owner = candidate;
  }
  return {
    plugin: '响应检查器', version,
    privacy: '仅流程状态、匿名会话编号和长度；不含正文、角色名、聊天ID、密钥或配置内容。',
    status: { session, enabled: settings.enabled === true, autoFix: settings.autoFix === true,
      previewMode: settings.defaultAutoFixAction === 'preview',
      streaming: isStreamingContext(ctx), epoch: currentGenerationEpoch(),
      messageIndex: index, swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : null,
      rawLength: typeof message?.mes === 'string' ? message.mes.length : 0,
      displayLength: typeof message?.extra?.display_text === 'string' ? message.extra.display_text.length : 0,
      pendingCount: messageModifier.pendingModifications.size, activeWrites: messageModifier.activeWrites.size,
      fixQueueLength: fixCoordinator.fixQueue.length, eventQueueLength: messageHandler.processingQueue.length,
      listening: messageHandler.isListening, owner,
      hostAvailable: !!ctx, saveAvailable: typeof (ctx?.saveChat || ctx?.saveChatConditional) === 'function',
    },
    ...getDiagnostics(),
  };
}
