import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

globalThis.window = globalThis;
globalThis.document = new EventTarget();
document.createElement = () => ({ textContent: '', get innerHTML() { return this.textContent; } });
let ctx;
globalThis.SillyTavern = { getContext: () => ctx };
const { createBackendController } = await import('../core/backend-controller.js');
const { messageHandler } = await import('../core/message-handler.js');
const { messageModifier, MessageModifier } = await import('../core/message-modifier.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { getMessageWriteCoordinator } = await import('../core/messageWriteCoordinator.js');
const controller = createBackendController('response-linter');
const eventNames = ['MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED'];
const source = '<think>secret</think><content>original</content>';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setText(message, text) { message.mes = text; message.extra.display_text = text; message.swipes[message.swipe_id] = text; }
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('condition did not become true');
}
beforeEach(async () => {
  const emitter = new EventEmitter();
  let saves = 0;
  const message = { mes: source, is_user: false, extra: { display_text: source, qianqianjie_floor: { id: 'floor' } },
    swipe_id: 0, swipes: [source, 'inactive'], swipe_info: [{ extra: { receipt: 'keep' } }] };
  ctx = { chat: [message], chatId: 'chat', extensionSettings: {},
    chatMetadata: { qianqianjie: { id: 'metadata' } },
    eventSource: emitter, eventTypes: Object.fromEntries(eventNames.map(n => [n, n])),
    updateMessageBlock: async () => {}, saveChat: async () => { saves++; }, get saves() { return saves; } };
  messageHandler.ctxRef = ctx;
  messageHandler.lastContent.clear(); messageHandler.lastStates.clear(); messageHandler.lastHandledAt.clear();
  messageModifier.modificationHistory.clear(); messageModifier.pendingModifications.clear();
  fixCoordinator._sleep = async () => {};
  controller.updateSettings({ enabled: true, autoFix: true, removeLeakedReasoning: true, defaultAutoFixAction: 'apply' });
  await until(() => messageHandler.isListening);
});
afterEach(async () => {
  await until(() => !fixCoordinator.isProcessing && !messageHandler.isProcessing);
  controller.updateSettings({ enabled: true, autoFix: false });
  for (const timer of messageHandler.deferredEvents.values()) clearTimeout(timer);
  messageHandler.deferredEvents.clear();
});

test('automatic plan is computed after the other plugin releases the shared chat lock', async () => {
  const gate = deferred();
  const external = getMessageWriteCoordinator().run(ctx.chat, 'veridis-rewrite', () => gate.promise);
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  await until(() => fixCoordinator.isProcessing);
  setText(ctx.chat[0], '<think>new thought</think><content>mapped words</content>');
  gate.resolve(); await external;
  await until(() => ctx.saves === 1);
  assert.equal(ctx.chat[0].mes, '<content>mapped words</content>');
  assert.equal(ctx.chat[0].extra.qianqianjie_floor.id, 'floor');
  assert.deepEqual(ctx.chatMetadata, { qianqianjie: { id: 'metadata' } });
});

for (const interruption of ['next user', 'generation']) {
  test(`queued automatic repair cancels after ${interruption} without changing historical text`, async () => {
    const gate = deferred();
    const external = getMessageWriteCoordinator().run(ctx.chat, 'veridis-rewrite', () => gate.promise);
    ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
    await until(() => fixCoordinator.isProcessing);
    if (interruption === 'next user') ctx.chat.push({ is_user: true, mes: 'next turn' });
    else ctx.eventSource.emit('GENERATION_STARTED');
    gate.resolve(); await external;
    await until(() => !fixCoordinator.isProcessing);
    assert.equal(ctx.saves, 0);
    assert.equal(ctx.chat[0].mes, source);
    assert.equal(messageModifier.canUndo('0'), false);
  });
}

test('an external update during rendering is replayed instead of silently marked processed', async () => {
  const entered = deferred(), gate = deferred();
  let render = 0;
  ctx.updateMessageBlock = async () => { if (++render === 1) { entered.resolve(); await gate.promise; } };
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  await entered.promise;
  setText(ctx.chat[0], '<think>later thought</think><content>external</content>');
  ctx.eventSource.emit('MESSAGE_UPDATED', 0);
  gate.resolve();
  await until(() => ctx.saves === 1);
  assert.equal(ctx.chat[0].mes, '<content>external</content>');
  assert.equal(messageModifier.getModificationHistory('0').length, 1);
});

test('an event inside the debounce interval is deferred, not dropped', async () => {
  setText(ctx.chat[0], '<content>clean</content>');
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  await until(() => !fixCoordinator.isProcessing && messageHandler.lastContent.has('0'));
  setText(ctx.chat[0], '<think>new</think><content>edited</content>');
  ctx.eventSource.emit('MESSAGE_UPDATED', 0);
  await until(() => ctx.saves === 1);
  assert.equal(ctx.chat[0].mes, '<content>edited</content>');
});

test('manual expected text comparison preserves whitespace changes', async () => {
  const modifier = new MessageModifier(); modifier.setEnabled(true);
  setText(ctx.chat[0], ' original ');
  const result = await modifier.modifyMessage('0', 'replacement', 'manual', false, 'original');
  assert.equal(result.success, false);
  assert.equal(ctx.chat[0].mes, ' original ');
  assert.equal(ctx.saves, 0);
});

test('next user during awaited render keeps already visible text stable and does not claim success', async () => {
  const entered = deferred(), gate = deferred();
  let calls = 0;
  ctx.updateMessageBlock = async () => { if (++calls === 1) { entered.resolve(); await gate.promise; } };
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  await entered.promise;
  ctx.chat.push({ is_user: true, mes: 'next user' });
  ctx.chat[0].extra.qqj_v3_recall_receipt = { added: true };
  gate.resolve();
  await until(() => !fixCoordinator.isProcessing);
  assert.equal(ctx.saves, 0);
  assert.equal(ctx.chat[0].mes, '<content>original</content>');
  assert.equal(messageModifier.canUndo('0'), false);
  assert.deepEqual(ctx.chat[0].extra.qqj_v3_recall_receipt, { added: true });
});

test('turning automatic repair off while waiting cancels its queued write', async () => {
  const gate = deferred();
  const external = getMessageWriteCoordinator().run(ctx.chat, 'veridis-rewrite', () => gate.promise);
  ctx.eventSource.emit('MESSAGE_RECEIVED', 0);
  await until(() => fixCoordinator.isProcessing);
  controller.updateSettings({ enabled: true, autoFix: false, removeLeakedReasoning: true });
  gate.resolve(); await external;
  await until(() => !fixCoordinator.isProcessing);
  assert.equal(ctx.saves, 0);
  assert.equal(ctx.chat[0].mes, source);
});

test('preview and undo reject a different chat array even if the same message object is reused', async () => {
  const modifier = new MessageModifier(); modifier.setEnabled(true);
  await modifier.modifyMessage('0', 'previewed', 'manual', true);
  ctx.chat = [...ctx.chat];
  assert.equal((await modifier.confirmModification('0', true)).success, false);
  assert.equal(ctx.saves, 0);
  assert.equal((await modifier.modifyMessage('0', 'committed')).success, true);
  ctx.chat = [...ctx.chat];
  assert.equal((await modifier.undoModification('0')).success, false);
  assert.equal(ctx.chat[0].mes, 'committed');
});
