import { getFreshContext, noteGenerationStarted, noteGenerationEnded, noteNavigation, noteFinalMessage,
  snapshotMessage, sameMessageState, chatIdentity, hasValidSwipe, isStreamingContext } from './host-context.js';
import { messageModifier } from './message-modifier.js';
import { recordDiagnostic } from './diagnostics.js';

let source = null;
let bindings = [];
let generation = null;

// TT can return before displaying the stop button, so GENERATION_ENDED is
// not guaranteed. Its idle gate also covers these early exits. Older hosts
// without the export continue to use their normal lifecycle events.
async function waitForHostIdle(ctx) {
  const host = typeof ctx?.waitForGenerationIdle === 'function' ? ctx : await import('/script.js');
  if (typeof host.waitForGenerationIdle !== 'function') return false;
  await host.waitForGenerationIdle();
  return true;
}

// Always active for manual previews too; automatic listening can be disabled.
export function ensureRepairLifecycle() {
  const ctx = getFreshContext();
  const next = ctx?.eventSource;
  const types = ctx?.eventTypes || ctx?.event_types;
  if (!next?.on || !types || next === source) return;
  for (const [name, handler] of bindings) {
    if (source?.off) source.off(name, handler); else source?.removeListener?.(name, handler);
  }
  bindings = []; source = next;
  const on = (name, handler) => { if (types[name]) { source.on(types[name], handler); bindings.push([types[name], handler]); } };
  const invalidate = reason => messageModifier.invalidatePreviews(reason);
  on('MESSAGE_SWIPED', index => {
    noteNavigation(); generation = null; invalidate('swipe_changed');
    recordDiagnostic('host.swipe', { messageIndex: index });
  });
  on('CHAT_CHANGED', () => {
    noteNavigation(); generation = null; invalidate('chat_changed');
    recordDiagnostic('host.chat_changed');
  });
  for (const name of ['MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED']) {
    on(name, () => { noteNavigation(); generation = null; invalidate('message_boundary'); });
  }
  on('GENERATION_STARTED', (type, options, dryRun) => {
    if (dryRun === true || type === 'quiet') return;
    const fresh = getFreshContext();
    const message = fresh?.chat?.at(-1);
    generation = { chat: fresh?.chat, chatId: chatIdentity(fresh), message, state: snapshotMessage(message) };
    noteGenerationStarted(); invalidate('generation_started');
    recordDiagnostic('host.generation_started');
    const entry = generation;
    void waitForHostIdle(fresh).then(idle => {
      if (idle && generation === entry) settled();
    }).catch(() => {});
  });
  const settled = () => {
    const entry = generation;
    generation = null;
    noteGenerationEnded();
    const fresh = getFreshContext();
    const message = fresh?.chat?.at(-1);
    recordDiagnostic('host.generation_ended');
    messageModifier.invalidateStalePreviews('generation_ended');
    if (!entry || entry.chat !== fresh?.chat || entry.chatId !== chatIdentity(fresh) ||
        !message || message.is_user || message.is_system || !hasValidSwipe(message) ||
        (entry.message === message && sameMessageState(message, entry.state))) return;
    noteFinalMessage();
    document.dispatchEvent(new CustomEvent('responseLinter.generationSettled', {
      detail: { messageId: String(message.id ?? fresh.chat.length - 1) },
    }));
  };
  on('GENERATION_ENDED', settled);
  on('GENERATION_STOPPED', settled);
  on('MESSAGE_RECEIVED', () => { if (!isStreamingContext(getFreshContext())) noteFinalMessage(); });
  for (const name of ['MESSAGE_UPDATED', 'MESSAGE_EDITED', 'CHARACTER_MESSAGE_RENDERED']) {
    on(name, index => {
      messageModifier.invalidateStalePreviews('message_changed');
      recordDiagnostic('host.message_updated', { messageIndex: index });
    });
  }
}
