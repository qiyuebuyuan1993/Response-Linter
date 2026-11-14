// Run: node --test tests/regression.mjs (Node.js 24).
// 1.4.10 core flow: structure-only manual/auto/preview/undo, rollback and
// metadata preservation. Generic validation rules are intentionally absent.
import { registerHooks } from 'node:module';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Only the host bridge is mocked. Production modules run unchanged.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/st-context.js')) return {
    url: 'data:text/javascript,export const getContext = () => globalThis.__testContext;', shortCircuit: true,
  };
  return nextResolve(specifier, context);
} });
globalThis.window = globalThis;
globalThis.document = new EventTarget();
document.createElement = () => ({ textContent: '', get innerHTML() { return this.textContent; } });
globalThis.__testContext = { chat: [], extensionSettings: {}, saveChat: async () => {} };
globalThis.getContext = () => globalThis.__testContext;
globalThis.SillyTavern = { getContext };
globalThis.ResponseLinter = {};

const { messageModifier } = await import('../core/message-modifier.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { createBackendController } = await import('../core/backend-controller.js');
const { validateStructureProfile } = await import('../core/structure-profiles.js');
const controller = createBackendController('response-linter');
controller.start = () => { controller.isRunning = true; };
controller.stop = () => { controller.isRunning = false; };
fixCoordinator._sleep = async () => {};

const plainProfile = validateStructureProfile({
  id: 'regression-plain',
  name: '回归测试结构',
  body: { open: '【正文】', close: '【/正文】' },
  time: { mode: 'none' },
  auxiliaries: ['【水印】'],
  blocks: [],
}).profile;

let saves, failSave, failRender;
function messageFixture(mes, { swipe = mes, extra = {} } = {}) {
  return { mes, is_user: false, swipe_id: 0, swipes: [swipe], extra: { display_text: mes, ...extra } };
}
function waitForEvent(name, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { document.removeEventListener(name, onEvent); reject(new Error(`timeout: ${name}`)); }, timeoutMs);
    const onEvent = event => {
      clearTimeout(timer);
      document.removeEventListener(name, onEvent);
      resolve(event.detail);
    };
    document.addEventListener(name, onEvent);
  });
}
function enable(overrides = {}) {
  controller.updateSettings({
    enabled: true,
    autoFix: false,
    defaultAutoFixAction: 'apply',
    ...overrides,
  });
}

beforeEach(() => {
  assert.equal(fixCoordinator.fixQueue.length, 0);
  fixCoordinator.isProcessing = false;
  fixCoordinator._sleep = async () => {};
  messageModifier.modificationHistory.clear();
  messageModifier.pendingModifications.clear();
  messageHandler.lastContent.clear();
  messageHandler.lastHandledAt.clear();
  messageHandler.retryCounts.clear();
  messageHandler.ctxRef = null;
  saves = 0; failSave = false; failRender = false;
  __testContext.chat = [messageFixture('<thinking>泄漏</thinking>\n<content>正文</content>')];
  __testContext.chatMetadata = {};
  __testContext.streamingProcessor = null;
  __testContext.eventSource = { emit() { this.emitted = (this.emitted || 0) + 1; }, emitted: 0 };
  __testContext.updateMessageBlock = async id => {
    if (failRender) throw new Error('render failed');
    await messageHandler._handleMessageRendered(String(id));
  };
  __testContext.saveChat = async () => {
    if (failSave) throw new Error('save failed');
    saves++;
  };
  globalThis.UIState = { rules: [] };
  controller.resetStatistics();
  enable({ removeLeakedReasoning: true });
});

test('manual structure repair works with auto repair off, including message index zero', async () => {
  const result = await controller.triggerManualFix('0');
  assert.equal(result.success, true);
  const message = __testContext.chat[0];
  assert.equal(message.mes, '<content>正文</content>');
  assert.equal(message.extra.display_text, message.mes);
  assert.equal(message.swipes[0], message.mes);
  assert.equal(saves, 1);
  assert.equal(controller.canUndoFix('0'), true);
  assert.equal(controller.getFixHistory('0').length, 1);
  assert.equal(controller.getStatistics().successfulFixes, 1);
  assert.equal(controller.getFixStatistics().totalAttempts, 1);
});

test('enabled malicious legacy rule is ignored by manual and auto repair while reasoning cleanup works', async () => {
  let legacyExecuted = false;
  const legacyRule = {
    id: 'legacy-malicious',
    name: '旧恶意规则',
    enabled: true,
    requiredContent: ['<content>', '</content>'],
    fixStrategy: 'custom',
    customStrategy: { pattern: '.*', replacement: '<broken>' },
    execute: () => { legacyExecuted = true; },
  };
  __testContext.chat = [messageFixture('<thinking>泄漏</thinking>\n<content>正文')];
  enable({ rules: [legacyRule], removeLeakedReasoning: true });
  const manual = await controller.triggerManualFix('0');
  assert.equal(manual.success, true);
  assert.equal(__testContext.chat[0].mes, '<content>正文');
  assert.equal(legacyExecuted, false);
  assert.equal(saves, 1);

  __testContext.chat = [messageFixture('<thinking>泄漏</thinking>\n<content>正文')];
  messageHandler.lastContent.clear();
  enable({ rules: [legacyRule], removeLeakedReasoning: true, autoFix: true });
  const applied = waitForEvent('responseLinter.fixApplied');
  await messageHandler._processMessage('0');
  await applied;
  assert.equal(__testContext.chat[0].mes, '<content>正文');
  assert.equal(legacyExecuted, false);
  assert.equal(saves, 2);
});

test('no enabled structure feature causes no mutation even with auto repair and a legacy rule', async () => {
  let executed = false;
  const legacyRule = { id: 'evil', enabled: true, requiredContent: ['</content>'], execute: () => { executed = true; } };
  __testContext.chat = [messageFixture('<content>正文')];
  enable({ rules: [legacyRule], removeLeakedReasoning: false, repairSdcBoundary: false, repairDetailsOrder: false, autoFix: true });
  const before = structuredClone(__testContext.chat[0]);
  const manual = await controller.triggerManualFix('0');
  assert.equal(manual.success, false);
  assert.match(manual.reason, /未启用/);
  await controller._handleMessageProcessed({ messageId: '0', content: '<content>正文', name: 'AI' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(__testContext.chat[0], before);
  assert.equal(saves, 0);
  assert.equal(executed, false);
  assert.equal(fixCoordinator.fixQueue.length, 0);
});

test('preview confirmation does not write early and refuses edits or chat switches', async () => {
  enable({ removeLeakedReasoning: true, defaultAutoFixAction: 'preview' });
  const pending = await controller.triggerManualFix('0');
  assert.equal(pending.metadata.requiresConfirmation, true);
  assert.equal(saves, 0);
  __testContext.chat[0].mes += ' edited';
  __testContext.chat[0].extra.display_text = __testContext.chat[0].mes;
  __testContext.chat[0].swipes[0] = __testContext.chat[0].mes;
  assert.equal((await controller.confirmFix('0', true)).success, false);
  assert.equal(saves, 0);

  __testContext.chat = [messageFixture('<thinking>泄漏</thinking>\n<content>正文</content>')];
  await controller.triggerManualFix('0');
  __testContext.chat = [messageFixture('<content>other chat')];
  assert.equal((await controller.confirmFix('0', true)).success, false);
  assert.equal(saves, 0);
});

test('a second repair cannot replace or bypass the plan currently shown in preview', async () => {
  enable({ removeLeakedReasoning: true, defaultAutoFixAction: 'preview' });
  await controller.triggerManualFix('0');
  const pending = messageModifier.pendingModifications.get('0');
  for (const preview of [true, false]) {
    const result = await messageModifier.modifyMessage('0', 'unexpected replacement', 'manual', preview);
    assert.equal(result.success, false);
    assert.equal(messageModifier.pendingModifications.get('0'), pending);
    assert.equal(saves, 0);
  }
  assert.equal((await controller.confirmFix('0', true)).success, true);
  assert.equal(__testContext.chat[0].mes, pending.newContent);
  assert.equal(saves, 1);
});

test('confirmed and cancelled fixes are counted once and reset remains functional', async () => {
  enable({ removeLeakedReasoning: true, defaultAutoFixAction: 'preview' });
  await controller.triggerManualFix('0');
  await controller.confirmFix('0', false);
  await controller.confirmFix('0', false);
  assert.equal(controller.getStatistics().userCancellations, 1);
  await controller.triggerManualFix('0');
  assert.equal((await controller.confirmFix('0', true)).success, true);
  assert.equal(controller.getStatistics().successfulFixes, 1);
  assert.equal(controller.getFixStatistics().totalAttempts, 2);
  controller.resetStatistics();
  assert.equal(controller.getStatistics().successfulFixes, 0);
  assert.equal(controller.getFixStatistics().totalAttempts, 0);
});

test('save/render failures roll back fields and preserve undo history', async () => {
  const original = structuredClone(__testContext.chat[0]);
  failRender = true;
  assert.equal((await controller.triggerManualFix('0')).success, false);
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(controller.canUndoFix('0'), false);

  failRender = false; failSave = true;
  assert.equal((await controller.triggerManualFix('0')).success, false);
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(controller.canUndoFix('0'), false);

  failSave = false;
  await controller.triggerManualFix('0');
  const repaired = structuredClone(__testContext.chat[0]);
  failSave = true;
  assert.equal((await controller.undoFix('0')).success, false);
  assert.deepEqual(__testContext.chat[0], repaired);
  assert.equal(controller.getFixHistory('0').length, 1);
});

test('undo restores raw/display/swipe text and is not automatically repeated with features disabled', async () => {
  const original = structuredClone(__testContext.chat[0]);
  await controller.triggerManualFix('0');
  enable({ removeLeakedReasoning: false, autoFix: true });
  const undone = await controller.undoFix('0');
  assert.equal(undone.success, true);
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(saves, 2);
  assert.equal(controller.canUndoFix('0'), false);
  await messageHandler._processMessage('0');
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(saves, 2);
});

test('undo restores distinct raw and display values with bounded multi-step history', async () => {
  const message = __testContext.chat[0];
  message.mes = 'raw'; message.extra = { display_text: 'display', keep: 1 };
  message.swipes[0] = 'swipe';
  const original = structuredClone(message);
  await messageModifier.modifyMessage('0', 'one');
  await messageModifier.modifyMessage('0', 'two');
  assert.equal((await controller.undoFix('0', 2)).success, true);
  assert.deepEqual(message, original);
  assert.equal((await controller.undoFix('0', 0)).success, false);
  for (let i = 0; i < 12; i++) await messageModifier.modifyMessage('0', String(i));
  assert.equal(controller.getFixHistory('0').length, 10);
  assert.equal((await controller.undoFix('0', 99)).success, true);
  assert.equal(message.mes, '1');
});

test('undo cannot affect another chat, swipe or a later manual edit', async () => {
  await controller.triggerManualFix('0');
  const message = __testContext.chat[0];
  message.mes += ' edited';
  assert.equal((await controller.undoFix('0')).success, false);
  __testContext.chat = [messageFixture('other chat')];
  assert.equal(controller.canUndoFix('0'), false);
  assert.equal((await controller.undoFix('0')).success, false);
  __testContext.chat = [message];
  await messageModifier.modifyMessage('0', 'new version');
  message.swipe_id = 1; message.swipes.push('another swipe');
  assert.equal(controller.canUndoFix('0'), false);
});

test('previewLatestFix is zero-write and an unconfigured generic rule cannot alter its result', () => {
  const before = structuredClone(__testContext.chat);
  const preview = controller.previewLatestFix();
  assert.equal(preview.success, true);
  assert.equal(preview.newContent, '<content>正文</content>');
  assert.deepEqual(__testContext.chat, before);
  assert.equal(saves, 0);
  const legacy = controller.previewFix('<content>正文', ['</content>'], 'add-missing-tags');
  assert.equal(legacy.success, false);
  assert.match(legacy.reason, /已移除通用规则/);
});

test('body-boundary repair, undo and save rollback preserve memory-extra, swipe_info and chat metadata', async () => {
  const source = '【正文】叙事\n【水印】logo\n【/正文】';
  const extra = {
    display_text: source,
    qianqianjie_floor: { schemaVersion: 2, floorId: 'floor-a' },
    qqj_v3_recall_receipt: { schemaVersion: 1, fingerprint: 'fp-a' },
    qianqianjieAutoHide: { schemaVersion: 1, chatId: 'q' },
    qianqianjie_memory_excluded: true,
    keep_me: { nested: [1, 2, 3] },
  };
  const message = {
    name: 'AI', is_user: false, swipe_id: 0,
    mes: source, swipes: [source, '<正文>另一个候选</正文>'],
    swipe_info: [{ extra: { ...extra } }, { extra: { display_text: '<正文>另一个候选</正文>' } }],
    extra: { ...extra },
  };
  __testContext.chat = [message];
  __testContext.chatMetadata = {
    qianqianjie: { schemaVersion: 2, chatId: 'q' },
    'sp-store': { data: { stable: true } },
    other: { nested: true },
  };
  const metadataSnapshot = structuredClone(__testContext.chatMetadata);
  const extraSnapshot = structuredClone(message.extra);
  const swipeInfoSnapshot = structuredClone(message.swipe_info);
  enable({
    removeLeakedReasoning: false,
    repairSdcBoundary: true,
    repairDetailsOrder: false,
    structureProfilesVersion: 1,
    structureProfiles: [plainProfile],
    structureProfileId: plainProfile.id,
  });

  const repaired = await controller.triggerManualFix('0');
  assert.equal(repaired.success, true);
  assert.ok(message.mes.indexOf('【/正文】') < message.mes.indexOf('【水印】'));
  assert.equal(message.extra.display_text, message.mes);
  assert.equal(message.swipes[0], message.mes);
  assert.equal(message.swipes[1], '<正文>另一个候选</正文>', 'inactive swipe unchanged');
  assert.deepEqual(message.swipe_info, swipeInfoSnapshot);
  assert.deepEqual(__testContext.chatMetadata, metadataSnapshot);
  assert.deepEqual({ ...message.extra, display_text: extraSnapshot.display_text }, extraSnapshot);
  assert.equal(__testContext.eventSource.emitted, 0);
  assert.equal(saves, 1);

  const undo = await controller.undoFix('0');
  assert.equal(undo.success, true);
  assert.equal(message.mes, source);
  assert.equal(message.extra.display_text, source);
  assert.equal(message.swipes[0], source);
  assert.equal(message.swipes[1], '<正文>另一个候选</正文>');
  assert.deepEqual(message.swipe_info, swipeInfoSnapshot);
  assert.deepEqual(__testContext.chatMetadata, metadataSnapshot);

  __testContext.saveChat = async () => { throw new Error('save failed'); };
  const beforeRollback = structuredClone(message);
  const failed = await controller.triggerManualFix('0');
  assert.equal(failed.success, false);
  assert.equal(message.mes, beforeRollback.mes);
  assert.equal(message.extra.display_text, beforeRollback.extra.display_text);
  assert.equal(message.swipes[0], beforeRollback.swipes[0]);
  assert.deepEqual(message.swipe_info, swipeInfoSnapshot);
  assert.deepEqual(__testContext.chatMetadata, metadataSnapshot);
});

test('streaming context rejects manual and auto structure repair without writing', async () => {
  __testContext.streamingProcessor = { isFinished: false };
  const before = structuredClone(__testContext.chat[0]);
  const manual = await controller.triggerManualFix('0');
  assert.equal(manual.success, false);
  assert.match(manual.reason, /流式/);
  enable({ removeLeakedReasoning: true, autoFix: true });
  await controller._handleMessageProcessed({ messageId: '0', content: before.mes, name: 'AI' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(__testContext.chat[0], before);
  assert.equal(saves, 0);
  assert.equal(fixCoordinator.fixQueue.length, 0);
});
