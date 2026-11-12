// Run: node --test tests/regression.mjs (Node.js 22.15+).
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
const { validationEngine, ValidationEngine } = await import('../core/validation-engine.js');
const { autoFixEngine } = await import('../core/auto-fix-engine.js');
const { messageModifier } = await import('../core/message-modifier.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { createBackendController } = await import('../core/backend-controller.js');
const { RuleEditorUI } = await import('../presentation/modules/rule-editor-ui.js');
const { RulesManagerUI } = await import('../presentation/modules/rules-manager-ui.js');
const controller = createBackendController('response-linter');
// Listener binding isn't under test here; message processing itself is exercised below.
controller.start = () => { controller.isRunning = true; };
const rule = () => ({ id: 'r', name: '正文', enabled: true,
  requiredContent: ['<content>', '</content>'], fixStrategy: 'add-missing-tags' });
let saves, failSave, failRender;
beforeEach(() => {
  assert.equal(fixCoordinator.fixQueue.length, 0);
  fixCoordinator.isProcessing = false;
  fixCoordinator._sleep = async () => {};
  messageModifier.modificationHistory.clear();
  messageModifier.pendingModifications.clear();
  messageHandler.lastContent.clear();
  messageHandler.lastHandledAt.clear();
  messageHandler.ctxRef = null;
  saves = 0; failSave = false; failRender = false;
  __testContext.chat = [{ mes: '<content>正文', is_user: false, swipe_id: 0, swipes: ['<content>正文'] }];
  __testContext.updateMessageBlock = async id => {
    if (failRender) throw Error('render failed');
    await messageHandler._handleMessageRendered(String(id));
  };
  __testContext.saveChat = async () => { if (failSave) throw Error('save failed'); saves++; };
  globalThis.UIState = { rules: [rule()] };
  ResponseLinter.CurrentRule = null;
  controller.updateSettings({ enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: UIState.rules });
  controller.resetStatistics();
});

test('manual repair works with automatic repair off, including message index zero and legacy strategy', async () => {
  const result = await controller.triggerManualFix('0');
  assert.equal(result.success, true);
  const message = __testContext.chat[0];
  assert.equal(message.mes, '<content>正文\n</content>');
  assert.equal(message.extra.display_text, message.mes);
  assert.equal(message.swipes[0], message.mes);
  assert.equal(saves, 1);
  assert.equal(controller.canUndoFix('0'), true);
  assert.equal(controller.getFixHistory('0').length, 1);
  assert.equal(controller.getStatistics().successfulFixes, 1);
  assert.equal(controller.getFixStatistics().totalAttempts, 1);
});

test('manual repair reports unavailable strategy instead of reporting queue success', async () => {
  UIState.rules[0].fixStrategy = 'unknown';
  const result = await controller.triggerManualFix('0');
  assert.equal(result.success, false);
  assert.equal(saves, 0);
  assert.equal(controller.canUndoFix('0'), false);
});

test('disabled items stay saved, are skipped in validation, and can be reenabled after reload', async () => {
  const r = rule(); r.contentOptions = { '</content>': { enabled: false } };
  const engine = new ValidationEngine();
  engine.initialize([r], true);
  assert.equal(engine.validateMessage('<content>正文', '0').isValid, true);
  globalThis.UIState = { rules: [r] };
  await RulesManagerUI.initialize();
  const manager = window.RulesManager;
  manager.setUIState(UIState);
  await manager.saveRules();
  const saved = JSON.parse(JSON.stringify(__testContext.extensionSettings['response-linter'].rules[0]));
  assert.deepEqual(saved.requiredContent, ['<content>', '</content>']);
  assert.equal(saved.contentOptions['</content>'].enabled, false);
  engine.initialize([saved], true);
  assert.equal(engine.validateMessage('<content>正文', '0').isValid, true);
  saved.contentOptions['</content>'].enabled = true;
  assert.equal(engine.validateMessage('<content>正文', '0').isValid, false);
});

test('disabled actions and anchors are excluded from repair', () => {
  const r = { ...rule(), requiredContent: ['<off>', '<content>', '</content>'],
    contentOptions: { '<off>': { enabled: false, actions: ['custom'], pattern: '正文', replacement: '错误' } } };
  const preview = controller.previewFix('正文</content>', ['<content>'], 'positional', r);
  assert.equal(preview.success, true);
  assert.ok(!preview.newContent.includes('<off>'));
  assert.ok(preview.newContent.includes('正文'));
});

test('undo restores raw/display/swipe text, saves, and is not immediately automatically repaired', async () => {
  const original = structuredClone(__testContext.chat[0]);
  await controller.triggerManualFix('0');
  fixCoordinator.updateSettings({ enabled: true, autoFix: true, defaultAutoFixAction: 'apply' });
  const undone = await controller.undoFix('0');
  assert.equal(undone.success, true);
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(saves, 2);
  assert.equal(controller.canUndoFix('0'), false);
  await messageHandler._processMessage('0');
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(saves, 2);
});

test('undo restores distinct original raw and display values and bounded multi-step history', async () => {
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

test('save/render failures roll back fields and preserve undo history', async () => {
  const original = structuredClone(__testContext.chat[0]);
  failRender = true;
  assert.equal((await controller.triggerManualFix('0')).success, false);
  assert.deepEqual(__testContext.chat[0], original);
  assert.equal(controller.canUndoFix('0'), false);
  failRender = false; failSave = true;
  assert.equal((await controller.triggerManualFix('0')).success, false);
  assert.deepEqual(__testContext.chat[0], original);
  failSave = false;
  await controller.triggerManualFix('0');
  const repaired = structuredClone(__testContext.chat[0]);
  failSave = true;
  assert.equal((await controller.undoFix('0')).success, false);
  assert.deepEqual(__testContext.chat[0], repaired);
  assert.equal(controller.getFixHistory('0').length, 1);
});

test('preview confirmation does not write early and refuses edits or chat switches', async () => {
  fixCoordinator.updateSettings({ enabled: true, autoFix: false, defaultAutoFixAction: 'preview' });
  const pending = await controller.triggerManualFix('0');
  assert.equal(pending.metadata.requiresConfirmation, true);
  assert.equal(saves, 0);
  __testContext.chat[0].mes += 'edited';
  assert.equal((await controller.confirmFix('0', true)).success, false);
  assert.equal(saves, 0);
  await controller.triggerManualFix('0');
  __testContext.chat = [{ mes: '<content>other chat' }];
  assert.equal((await controller.confirmFix('0', true)).success, false);
  assert.equal(saves, 0);
});

test('confirmed and cancelled fixes are counted once, reset is functional', async () => {
  fixCoordinator.updateSettings({ enabled: true, autoFix: false, defaultAutoFixAction: 'preview' });
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

test('undo cannot affect another chat, swipe or a later manual edit', async () => {
  await controller.triggerManualFix('0');
  const message = __testContext.chat[0];
  message.mes += ' edited';
  assert.equal((await controller.undoFix('0')).success, false);
  __testContext.chat = [{ mes: 'other chat' }];
  assert.equal(controller.canUndoFix('0'), false);
  assert.equal((await controller.undoFix('0')).success, false);
  __testContext.chat = [message];
  await messageModifier.modifyMessage('0', 'new version');
  message.swipe_id = 1; message.swipes.push('another swipe');
  assert.equal(controller.canUndoFix('0'), false);
});

test('ordered repeated tags/code fences consume separate occurrences', () => {
  const engine = new ValidationEngine();
  engine.initialize([rule()], true);
  assert.equal(engine.validateMessage('<content>a</content><content>b</content>', '0').isValid, true);
  assert.equal(engine.validateMessage('</content>a<content>', '0').errorType, 'order');
  engine.initialize([{ ...rule(), requiredContent: ['```', '```'] }], true);
  assert.equal(engine.validateMessage('```js\nhello\n```', '0').isValid, true);
  assert.equal(engine.validateMessage('```js\nhello', '0').isValid, false);
});

test('preview uses latest rule and cannot change messages or engine enable state', () => {
  const before = structuredClone(__testContext.chat);
  autoFixEngine.setEnabled(false);
  ResponseLinter.CurrentRule = { id: 'previous' };
  const preview = controller.previewLatestFix();
  assert.equal(preview.success, true);
  assert.deepEqual(__testContext.chat, before);
  assert.equal(autoFixEngine.isEnabled, false);
  assert.equal(ResponseLinter.CurrentRule.id, 'previous');
  assert.equal(saves, 0);
});

test('explicit repair never falls back to deleting undeclared tags', () => {
  const r = rule();
  const source = '<content><details>keep me</details></content>';
  const preview = controller.previewFix(source, [], 'unknown', r);
  assert.equal(preview.success, false);
  assert.equal(preview.newContent, source);
});

test('new-rule content actions are kept in draft instead of mutating an existing rule', () => {
  const editor = new RuleEditorUI();
  const before = structuredClone(UIState.rules);
  editor.setContentActions('<content>', ['custom'], 'pattern', '');
  assert.equal(editor.contentOptions['<content>'].replacement, '');
  assert.deepEqual(UIState.rules, before);
});

test('editing a disabled item uses a cancellable draft and saves its enabled state', () => {
  const fields = new Map();
  const field = selector => {
    if (!fields.has(selector)) fields.set(selector, {
      value: '', props: {}, jquery: 'test', length: 0,
      val(value) { if (arguments.length) { this.value = value; return this; } return this.value; },
      prop(key, value) { if (arguments.length > 1) { this.props[key] = value; return this; } return this.props[key]; },
      text() { return this; }, remove() { return this; }, append() { return this; },
      show() { return this; }, hide() { return this; }, fadeOut(_ms, done) { done?.(); },
      removeClass() { return this; },
    });
    return fields.get(selector);
  };
  globalThis.$ = target => typeof target === 'string' ? field(target) : target;
  globalThis.HTMLElement = class {};
  globalThis.CSS = { escape: value => value };
  document.querySelector = () => null;
  const editor = new RuleEditorUI(); editor.setUIState(UIState);
  editor.updateTagsList = () => {}; editor.showModal = () => {};
  const original = rule(); original.contentOptions = { '</content>': { enabled: false, actions: ['balance-pairs'] } };
  UIState.rules = [original];
  editor.showEditModal('r');
  const row = { jquery: 'test', attr: () => '</content>', toggleClass() {} };
  editor.toggleContentItem(row, true);
  assert.equal(original.contentOptions['</content>'].enabled, false);
  editor.hideModal();
  assert.equal(original.contentOptions['</content>'].enabled, false);
  editor.showEditModal('r');
  assert.equal(editor.contentOptions['</content>'].enabled, false);
  editor.toggleContentItem(row, true);
  let saved;
  window.RulesManager = { editRule: (_id, data) => { saved = data; } };
  editor.saveRule();
  assert.equal(saved.contentOptions['</content>'].enabled, true);
  assert.deepEqual(saved.contentOptions['</content>'].actions, ['balance-pairs']);
  delete globalThis.$;
});

test('standalone browser harness has working imports and passes its assertions', async () => {
  const output = { innerHTML: '' };
  document.getElementById = () => output;
  await import('./harness.js');
  await new Promise(resolve => setTimeout(resolve, 350));
  const counts = output.innerHTML.match(/通过 (\d+) \/ (\d+) 项/);
  assert.ok(counts);
  assert.equal(counts[1], counts[2]);
});
