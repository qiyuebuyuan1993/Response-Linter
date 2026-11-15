import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
globalThis.window = globalThis;
globalThis.document = new EventTarget();
document.createElement = () => ({ textContent: '', get innerHTML() { return this.textContent; } });
let ctx;
globalThis.SillyTavern = { getContext: () => ctx };
const { createBackendController } = await import('../core/backend-controller.js');
const { messageModifier } = await import('../core/message-modifier.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { diagnosticSnapshot } = await import('../core/diagnostic-status.js');
const { clearDiagnostics, getDiagnostics } = await import('../core/diagnostics.js');
const { isStreamingContext } = await import('../core/host-context.js');
const controller = createBackendController('response-linter');
const settings = { enabled: true, autoFix: true, removeLeakedReasoning: true, defaultAutoFixAction: 'preview' };
const A = '<think>PRIVATE_THOUGHT</think><content>A</content>';
const B = '<think>PRIVATE_THOUGHT_B</think><content>B</content>';
let confirmations = [], invalidations = [], saves;
document.addEventListener('responseLinter.confirmationRequired', e => confirmations.push(e.detail));
document.addEventListener('responseLinter.previewInvalidated', e => invalidations.push(e.detail));
async function until(fn) { for (let i = 0; i < 160; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }
function showSwipe(id) { const m = ctx.chat[0]; m.swipe_id = id; m.mes = m.swipes[id] ?? A; m.extra.display_text = m.mes; ctx.eventSource.emit('MESSAGE_SWIPED', 0); }
beforeEach(async () => {
  saves = 0; confirmations = []; invalidations = []; clearDiagnostics();
  const names = ['MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_SENT'];
  ctx = { chatId: 'PRIVATE_CHAT_ID', extensionSettings: {}, chat: [{ is_user: false, mes: A, swipe_id: 0, swipes: [A, B],
    extra: { display_text: A, qianqianjie_floor: { keep: true } }, swipe_info: [{ extra: { receipt: 'keep' } }] }],
    chatMetadata: { PRIVATE_METADATA: 'not logged' }, eventSource: new EventEmitter(),
    eventTypes: Object.fromEntries(names.map(n => [n, n])), updateMessageBlock: async () => {}, saveChat: async () => { saves++; } };
  messageHandler.ctxRef = ctx; messageHandler.lastContent.clear(); messageHandler.lastStates.clear(); messageHandler.lastHandledAt.clear();
  fixCoordinator._sleep = async () => {};
  controller.updateSettings(settings);
  await until(() => messageHandler.isListening);
});
afterEach(async () => { await until(() => !fixCoordinator.isProcessing && !messageHandler.isProcessing); controller.updateSettings({ ...settings, autoFix: false }); });

test('swipe invalidates preview immediately and cannot confirm old text', async () => {
  await controller.triggerManualFix('0'); const old = confirmations.at(-1);
  showSwipe(1);
  assert.equal(messageModifier.pendingModifications.size, 0);
  assert.equal(invalidations.at(-1).token, old.token);
  assert.equal((await controller.confirmFix('0', true, old.token)).success, false);
  assert.equal(ctx.chat[0].mes, B); assert.equal(saves, 0);
});

test('TT overswipe before Generate does not preview old text; only changed final response is previewed', async () => {
  await controller.triggerManualFix('0'); const old = confirmations.at(-1);
  showSwipe(2); // TT announces navigation before GENERATION_STARTED.
  ctx.eventSource.emit('MESSAGE_UPDATED', 0); ctx.eventSource.emit('CHARACTER_MESSAGE_RENDERED', 0);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(confirmations.length, 1); assert.equal(messageModifier.pendingModifications.size, 0);
  ctx.eventSource.emit('GENERATION_STARTED', 'swipe', {}, false);
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  assert.equal((await controller.triggerManualFix('0')).success, false);
  const fresh = '<think>fresh</think><content>new response</content>';
  Object.assign(ctx.chat[0], { mes: fresh }); ctx.chat[0].extra.display_text = fresh; ctx.chat[0].swipes.push(fresh);
  ctx.eventSource.emit('CHARACTER_MESSAGE_RENDERED', 0);
  assert.equal(confirmations.length, 1);
  ctx.eventSource.emit('GENERATION_ENDED');
  await until(() => confirmations.length === 2);
  assert.equal(confirmations[1].newContent, '<content>new response</content>');
  assert.notEqual(confirmations[1].token, old.token); assert.equal(saves, 0);
});

test('old token cannot consume or confirm a newer preview with the same message index', async () => {
  await controller.triggerManualFix('0'); const old = confirmations.at(-1);
  showSwipe(1); await controller.triggerManualFix('0'); const current = confirmations.at(-1);
  assert.equal((await controller.confirmFix('0', true, old.token)).success, false);
  assert.equal(controller.isPreviewCurrent(current.token), true);
  assert.equal((await controller.confirmFix('0', true, current.token)).success, true);
  assert.equal(ctx.chat[0].mes, '<content>B</content>'); assert.equal(saves, 1);
});

test('A to B to A navigation never revives a prior preview', async () => {
  await controller.triggerManualFix('0'); const old = confirmations.at(-1);
  showSwipe(1); showSwipe(0);
  assert.equal(controller.isPreviewCurrent(old.token), false);
  assert.equal((await controller.confirmFix('0', true, old.token)).success, false);
  assert.equal(ctx.chat[0].mes, A);
});

test('manual preview invalidation stays active with automatic repair disabled; dry runs do not invalidate', async () => {
  controller.updateSettings({ ...settings, autoFix: false });
  await controller.triggerManualFix('0'); const old = confirmations.at(-1);
  ctx.eventSource.emit('GENERATION_STARTED', 'normal', {}, true);
  assert.equal(controller.isPreviewCurrent(old.token), true);
  ctx.eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
  assert.equal(controller.isPreviewCurrent(old.token), false);
  assert.equal(messageModifier.pendingModifications.size, 0);
  assert.equal((await controller.triggerManualFix('0')).success, false);
});

test('external text updates invalidate preview and export no message contents or private IDs', async () => {
  await controller.triggerManualFix('0'); const old = confirmations.at(-1);
  ctx.chat[0].mes = 'EXTERNAL_PRIVATE_CONTENT';
  ctx.eventSource.emit('MESSAGE_UPDATED', 0);
  assert.equal(controller.isPreviewCurrent(old.token), false);
  const json = JSON.stringify(diagnosticSnapshot(settings));
  for (const secret of ['PRIVATE_CHAT_ID', 'PRIVATE_THOUGHT', 'PRIVATE_METADATA', 'EXTERNAL_PRIVATE_CONTENT']) assert.equal(json.includes(secret), false);
  assert.ok(getDiagnostics().records.some(r => r.event === 'preview.invalidated'));
});

test('debounced old-swipe event cannot be retargeted to the new swipe', async () => {
  ctx.chat[0].mes = '<content>clean</content>'; ctx.chat[0].extra.display_text = ctx.chat[0].mes; ctx.chat[0].swipes[0] = ctx.chat[0].mes;
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  await until(() => messageHandler.lastContent.has('0'));
  ctx.chat[0].mes = A; ctx.chat[0].extra.display_text = A; ctx.chat[0].swipes[0] = A;
  ctx.eventSource.emit('MESSAGE_UPDATED', 0);
  showSwipe(1);
  await new Promise(r => setTimeout(r, 240));
  assert.equal(confirmations.length, 0); assert.equal(saves, 0);
});

test('TT early generation exit releases busy state without previewing unchanged text', async () => {
  let idle;
  ctx.waitForGenerationIdle = () => new Promise(resolve => { idle = resolve; });
  ctx.eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
  assert.equal(isStreamingContext(ctx), true);
  idle();
  await until(() => !isStreamingContext(ctx));
  assert.equal(confirmations.length, 0);
  await controller.triggerManualFix('0');
  assert.equal(confirmations.length, 1);
});

test('old idle completion cannot unlock a newer generation', async () => {
  const idle = [];
  ctx.waitForGenerationIdle = () => new Promise(resolve => idle.push(resolve));
  ctx.eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
  ctx.eventSource.emit('GENERATION_STARTED', 'swipe', {}, false);
  idle[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(isStreamingContext(ctx), true);
  idle[1]();
  await until(() => !isStreamingContext(ctx));
  assert.equal(confirmations.length, 0);
});
