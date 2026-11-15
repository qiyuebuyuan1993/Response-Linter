// Response Linter - MessageModifier concurrent-write race harness.
// Run (single file, same process; do not use isolation=none for the whole suite):
//   node --test --test-isolation=none tests/concurrent-writes-harness.mjs
//
// Only the host bridge is mocked. The production MessageModifier public API
// (modifyMessage / confirmModification / undoModification) is exercised unchanged.
// These tests intentionally assert the stricter concurrency contract from the
// review request, not the legacy behaviour; failures are review findings.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Host mock and import bootstrap
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function within(promise, label, timeoutMs = 1500) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeHost() {
  return {
    chatId: 'chat-a',
    chat: [],
    chatMetadata: {},
    eventSource: {
      events: [],
      emit(name) { this.events.push(String(name)); },
    },
    saveCalls: 0,
    renderCalls: 0,
    getCurrentChatId() { return this.chatId; },
    async updateMessageBlock() { this.renderCalls++; },
    async saveChat() { this.saveCalls++; },
  };
}

let host = makeHost();
globalThis.window = globalThis;
globalThis.document = new EventTarget();
globalThis.__testHost = host;
globalThis.SillyTavern = { getContext: () => globalThis.__testHost };
globalThis.getContext = () => globalThis.__testHost;
globalThis.window.getContext = globalThis.getContext;

const { messageModifier } = await import('../core/message-modifier.js');

function memoryExtra(display, suffix = 'message') {
  return {
    display_text: display,
    qianqianjie_floor: { schemaVersion: 2, chatId: 'chat-a', floorId: `floor-${suffix}`, anchor: { sourceId: 1 } },
    qqj_v3_recall_receipt: { schemaVersion: 1, fingerprint: `fp-${suffix}` },
    qianqianjie_memory_excluded: true,
    keep_me: { nested: [1, 2, 3] },
  };
}

function messageFixture({
  id = '0',
  mes = 'RAW ORIGINAL',
  display = 'DISPLAY ORIGINAL',
  swipes = ['SWIPE ORIGINAL'],
  swipeId = 0,
  extra = {},
} = {}) {
  return {
    id: String(id),
    name: 'AI',
    is_user: false,
    swipe_id: swipeId,
    mes,
    swipes: [...swipes],
    extra: { display_text: display, ...extra },
  };
}

function gateRender(target) {
  const started = deferred();
  const release = deferred();
  const calls = [];
  target.updateMessageBlock = async function (id, message, options) {
    this.renderCalls++;
    calls.push({ id, message, options });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
  };
  return { started: started.promise, release, calls };
}

function gateSave(target) {
  const started = deferred();
  const release = deferred();
  const calls = [];
  target.saveChat = async function () {
    this.saveCalls++;
    calls.push({ chat: this.chat, chatId: this.chatId, swipeId: this.chat?.[0]?.swipe_id });
    started.resolve();
    await release.promise;
  };
  return { started: started.promise, release, calls };
}

function assertNoMessageReceived(target) {
  const received = target.eventSource.events.filter(name => /^MESSAGE_RECEIVED$/i.test(name));
  assert.equal(received.length, 0, 'host MESSAGE_RECEIVED must not be emitted');
}

beforeEach(() => {
  host = makeHost();
  globalThis.__testHost = host;
  messageModifier.setEnabled(true);
  messageModifier.modificationHistory.clear();
  messageModifier.pendingModifications.clear();
  messageModifier.activeWrites.clear();
});

// ---------------------------------------------------------------------------
// 1. External full replacement during the awaited render
// ---------------------------------------------------------------------------

test('external full text replacement during render fails and is not overwritten', { timeout: 4000 }, async () => {
  const message = messageFixture();
  message.extra = memoryExtra('DISPLAY ORIGINAL');
  host.chat = [message];

  const render = gateRender(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);

  await within(render.started, 'first render start');

  // The host/extensions replace raw, display and active-swipe text while the
  // first render is still awaited. The write must detect this, not save it.
  message.mes = 'EXTERNAL RAW';
  message.extra = {
    display_text: 'EXTERNAL DISPLAY',
    qianqianjie_floor: { schemaVersion: 2, chatId: 'chat-a', floorId: 'external-floor' },
    external_added_during_render: { preserved: true },
  };
  message.swipes[message.swipe_id] = 'EXTERNAL SWIPE';

  render.release.resolve();
  const result = await pending;

  assert.equal(result.success, false, 'external replacement must not be reported as success');
  assert.equal(message.mes, 'EXTERNAL RAW', 'external raw text must survive');
  assert.equal(message.extra.display_text, 'EXTERNAL DISPLAY', 'external display text must survive');
  assert.equal(message.swipes[0], 'EXTERNAL SWIPE', 'external active swipe must survive');
  assert.equal(message.extra.external_added_during_render.preserved, true, 'external metadata must survive');
  assert.equal(message.extra.qianqianjie_floor.floorId, 'external-floor', 'external metadata value must not be rolled back');
  assert.equal(host.saveCalls, 0, 'no save may happen after external replacement');
});

test('external chat-object replacement during render fails without saving into the replacement', { timeout: 4000 }, async () => {
  const message = messageFixture();
  host.chat = [message];

  const render = gateRender(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(render.started, 'render start');

  const replacement = messageFixture({
    id: '0',
    mes: 'REPLACEMENT RAW',
    display: 'REPLACEMENT DISPLAY',
    swipes: ['REPLACEMENT SWIPE'],
    extra: { qianqianjie_floor: { floorId: 'replacement-floor' } },
  });
  const replacementBefore = structuredClone(replacement);
  host.chat[0] = replacement;

  render.release.resolve();
  const result = await pending;

  assert.equal(result.success, false, 'object replacement must fail the write');
  assert.equal(host.saveCalls, 0, 'replacement object must not be saved by this write');
  assert.deepEqual(host.chat[0], replacementBefore, 'replacement object fields must be byte-identical');
});

// ---------------------------------------------------------------------------
// 2. Save rejection: owned fields roll back, external field writes survive
// ---------------------------------------------------------------------------

test('save rejection rolls back owned text but preserves external field writes', { timeout: 4000 }, async () => {
  const message = messageFixture({ swipes: ['SWIPE ORIGINAL'] });
  message.extra = memoryExtra('DISPLAY ORIGINAL');
  message.swipe_info = [
    { extra: { display_text: 'DISPLAY ORIGINAL', qianqianjie_floor: { floorId: 'floor-active' } } },
    { extra: { display_text: 'INACTIVE SWIPE' } },
  ];
  host.chat = [message];
  host.chatMetadata = {
    qianqianjie: { schemaVersion: 2, chatId: 'chat-a' },
    other: { nested: true },
  };
  const metadataBefore = structuredClone(host.chatMetadata);

  const save = gateSave(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(save.started, 'save start');

  // External writer touches metadata and display_text while the save is pending.
  message.extra.qianqianjie_floor.floorId = 'external-floor';
  message.extra.external_added_during_save = { preserved: true };
  message.extra.display_text = 'EXTERNAL DISPLAY DURING SAVE';
  message.swipe_info[0].extra.external_added_during_save = { preserved: true };
  host.chatMetadata.qianqianjie.latestRevision = 7;
  host.chatMetadata.other.added_during_save = true;

  save.release.reject(new Error('save rejected'));
  const result = await pending;

  assert.equal(result.success, false, 'rejected save must fail');
  // Still-owned by this write: raw text and active swipe had no external edit.
  assert.equal(message.mes, 'RAW ORIGINAL', 'raw text must roll back');
  assert.equal(message.swipes[0], 'SWIPE ORIGINAL', 'active swipe text must roll back');
  // Externally written display text is no longer owned by this write.
  assert.equal(message.extra.display_text, 'EXTERNAL DISPLAY DURING SAVE', 'external display write must survive');
  assert.equal(message.extra.external_added_during_save.preserved, true, 'metadata appended during save must survive');
  assert.equal(message.extra.qianqianjie_floor.floorId, 'external-floor', 'external metadata mutation must survive');
  assert.deepEqual(message.swipe_info[0].extra.external_added_during_save, { preserved: true }, 'swipe_info append must survive');
  assert.equal(host.chatMetadata.qianqianjie.latestRevision, 7, 'chat metadata append must survive');
  assert.equal(host.chatMetadata.other.added_during_save, true, 'unrelated chat metadata append must survive');
  assert.deepEqual(host.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: 'chat-a', latestRevision: 7 }, 'pre-existing chat metadata preserved');
  assert.deepEqual(host.chatMetadata.other, { nested: true, added_during_save: true }, 'pre-existing unrelated metadata preserved');
  assert.equal(host.saveCalls, 1, 'one save attempt was made');
  assertNoMessageReceived(host);
});

// ---------------------------------------------------------------------------
// 3. Successful save: metadata appended during save is preserved
// ---------------------------------------------------------------------------

test('successful save preserves memory extra, swipe_info and chatMetadata appended during save', { timeout: 4000 }, async () => {
  const message = messageFixture();
  message.extra = memoryExtra('DISPLAY ORIGINAL');
  message.swipe_info = [
    { extra: { display_text: 'DISPLAY ORIGINAL', qianqianjie_floor: { floorId: 'floor-active' } } },
    { extra: { display_text: 'INACTIVE SWIPE', qianqianjie_floor: { floorId: 'floor-inactive' } } },
  ];
  const extraBefore = structuredClone(message.extra);
  const swipeInfoBefore = structuredClone(message.swipe_info);
  host.chat = [message];
  host.chatMetadata = {
    qianqianjie: { schemaVersion: 2, chatId: 'chat-a' },
    'sp-store': { data: { stable: true } },
    other: { nested: true },
  };

  const save = gateSave(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(save.started, 'save start');

  // A memory plugin appends ownership data while the host save is in flight.
  message.extra.added_during_save = { schemaVersion: 3, floorId: 'appended-floor' };
  message.swipe_info[0].extra.added_during_save = { receipt: 'active' };
  message.swipe_info[1].extra.added_during_save = { receipt: 'inactive' };
  host.chatMetadata.qianqianjie.latestRevision = 9;
  host.chatMetadata.other.added_during_save = true;

  save.release.resolve();
  const result = await pending;

  assert.equal(result.success, true, 'successful save must report success');
  assert.equal(message.mes, 'LR NEW CONTENT', 'raw text was written');
  assert.equal(message.extra.display_text, 'LR NEW CONTENT', 'display text was written');
  assert.equal(message.swipes[0], 'LR NEW CONTENT', 'active swipe was written');

  assert.deepEqual({ ...message.extra, display_text: extraBefore.display_text }, { ...extraBefore, added_during_save: message.extra.added_during_save },
    'pre-existing extra metadata unchanged, append preserved');
  assert.equal(message.extra.added_during_save.floorId, 'appended-floor', 'extra metadata appended during save preserved');
  assert.equal(message.extra.qianqianjie_floor.floorId, 'floor-message', 'pre-existing extra metadata preserved');

  const expectedSwipeInfo = structuredClone(swipeInfoBefore);
  expectedSwipeInfo[0].extra.added_during_save = { receipt: 'active' };
  expectedSwipeInfo[1].extra.added_during_save = { receipt: 'inactive' };
  assert.deepEqual(message.swipe_info, expectedSwipeInfo, 'swipe_info and its mid-save appends preserved');

  assert.deepEqual(host.chatMetadata.qianqianjie, { schemaVersion: 2, chatId: 'chat-a', latestRevision: 9 }, 'chat metadata preserved with mid-save append');
  assert.deepEqual(host.chatMetadata['sp-store'], { data: { stable: true } }, 'unrelated chat metadata preserved');
  assert.deepEqual(host.chatMetadata.other, { nested: true, added_during_save: true }, 'other metadata preserved with mid-save append');
  assert.equal(host.saveCalls, 1, 'exactly one save');
  assertNoMessageReceived(host);
});

// ---------------------------------------------------------------------------
// 4. Chat / swipe switches while awaiting render or save
// ---------------------------------------------------------------------------

test('chat switch during awaited render saves nothing and leaves the new chat intact', { timeout: 4000 }, async () => {
  const message = messageFixture();
  host.chat = [message];

  const render = gateRender(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(render.started, 'render start');

  const replacement = messageFixture({
    id: '0', mes: 'OTHER CHAT RAW', display: 'OTHER CHAT DISPLAY', swipes: ['OTHER CHAT SWIPE'],
  });
  const replacementBefore = structuredClone(replacement);
  host.chat = [replacement];
  host.chatId = 'chat-b';
  host.chatMetadata = { otherChat: { id: 'chat-b' } };

  render.release.resolve();
  const result = await pending;

  assert.equal(result.success, false, 'chat switch must fail the write');
  assert.equal(host.saveCalls, 0, 'no save may target the new chat');
  assert.deepEqual(host.chat[0], replacementBefore, 'new chat message must not be overwritten');
});

test('swipe switch during awaited render saves nothing and keeps the new swipe bytes', { timeout: 4000 }, async () => {
  const message = messageFixture({ swipes: ['SLOT 0 ORIGINAL', 'SLOT 1 ORIGINAL'], swipeId: 0 });
  host.chat = [message];

  const render = gateRender(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(render.started, 'render start');

  // Host switches to swipe 1 and writes its content while the render is pending.
  message.swipe_id = 1;
  message.mes = 'EXTERNAL SWIPE 1 RAW';
  message.extra.display_text = 'EXTERNAL SWIPE 1 DISPLAY';
  message.swipes[1] = 'EXTERNAL SWIPE 1 BYTES';

  render.release.resolve();
  const result = await pending;

  assert.equal(result.success, false, 'swipe switch must fail the write');
  assert.equal(host.saveCalls, 0, 'no save may target the switched swipe');
  assert.equal(message.swipe_id, 1, 'the host-selected swipe remains selected');
  assert.equal(message.mes, 'EXTERNAL SWIPE 1 RAW', 'external raw text of the new swipe survives');
  assert.equal(message.extra.display_text, 'EXTERNAL SWIPE 1 DISPLAY', 'external display of the new swipe survives');
  assert.equal(message.swipes[1], 'EXTERNAL SWIPE 1 BYTES', 'new swipe bytes must not be overwritten');
  assert.equal(message.swipes[0], 'LR NEW CONTENT', 'do not change previously visible text after the swipe boundary');
  assert.equal(result.metadata.rollbackSkipped, true);
});

test('chat switch while awaiting save is detected and the new chat is not overwritten', { timeout: 4000 }, async () => {
  const message = messageFixture();
  host.chat = [message];

  const save = gateSave(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(save.started, 'save start');

  const replacement = messageFixture({
    id: '0', mes: 'OTHER CHAT RAW', display: 'OTHER CHAT DISPLAY', swipes: ['OTHER CHAT SWIPE'],
  });
  const replacementBefore = structuredClone(replacement);
  host.chat = [replacement];
  host.chatId = 'chat-b';
  host.chatMetadata = { otherChat: { id: 'chat-b' } };

  save.release.resolve();
  const result = await pending;

  assert.equal(result.success, false, 'post-save chat switch must not report success');
  assert.deepEqual(host.chat[0], replacementBefore, 'new chat message must not be overwritten');
  assert.equal(host.saveCalls, 1, 'the host save was already invoked before the switch was observed');
  assert.equal(message.mes, 'LR NEW CONTENT', 'old chat text remains stable after switching away');
  assert.equal(result.metadata.rollbackSkipped, true);
});

test('swipe switch while awaiting save is detected and the new swipe is preserved', { timeout: 4000 }, async () => {
  const message = messageFixture({ swipes: ['SLOT 0 ORIGINAL', 'SLOT 1 ORIGINAL'], swipeId: 0 });
  host.chat = [message];

  const save = gateSave(host);
  const pending = messageModifier.modifyMessage('0', 'LR NEW CONTENT', 'manual', false);
  await within(save.started, 'save start');

  message.swipe_id = 1;
  message.mes = 'EXTERNAL SWIPE 1 RAW';
  message.extra.display_text = 'EXTERNAL SWIPE 1 DISPLAY';
  message.swipes[1] = 'EXTERNAL SWIPE 1 BYTES';

  save.release.resolve();
  const result = await pending;

  assert.equal(result.success, false, 'post-save swipe switch must not report success');
  assert.equal(message.swipe_id, 1);
  assert.equal(message.swipes[1], 'EXTERNAL SWIPE 1 BYTES', 'new swipe bytes must not be overwritten');
  assert.equal(message.mes, 'EXTERNAL SWIPE 1 RAW', 'external display source for the new swipe survives');
  assert.equal(message.extra.display_text, 'EXTERNAL SWIPE 1 DISPLAY', 'external display for the new swipe survives');
  assert.equal(message.swipes[0], 'LR NEW CONTENT', 'previously visible swipe text remains stable');
  assert.equal(result.metadata.rollbackSkipped, true);
});

// ---------------------------------------------------------------------------
// 5. Stale pending preview vs identical display text
// ---------------------------------------------------------------------------

test('pending preview is rejected when only raw mes changes under identical display text', { timeout: 4000 }, async () => {
  const message = messageFixture({ mes: 'RAW ORIGINAL', display: 'DISPLAY ORIGINAL', swipes: ['SWIPE ORIGINAL'] });
  host.chat = [message];

  const preview = await messageModifier.modifyMessage('0', 'NEW DISPLAY', 'manual', true);
  assert.equal(preview.success, false);
  assert.equal(preview.metadata.requiresConfirmation, true, 'preview must be pending');
  assert.equal(host.saveCalls, 0, 'preview is zero-write');

  // Display text stays byte-identical; only raw `mes` changes.
  message.mes = 'EXTERNAL RAW CHANGE';
  const confirmed = await messageModifier.confirmModification('0', true);

  assert.equal(confirmed.success, false, 'raw mes change must stale the preview');
  assert.equal(host.saveCalls, 0, 'stale preview must not save');
  assert.equal(message.mes, 'EXTERNAL RAW CHANGE', 'external raw text must survive');
  assert.equal(message.extra.display_text, 'DISPLAY ORIGINAL', 'display text remains untouched');
  assert.equal(message.swipes[0], 'SWIPE ORIGINAL', 'swipe text remains untouched');
});

test('pending preview is rejected when only the current swipe text changes under identical display text', { timeout: 4000 }, async () => {
  const message = messageFixture({ mes: 'RAW ORIGINAL', display: 'DISPLAY ORIGINAL', swipes: ['SWIPE ORIGINAL'] });
  host.chat = [message];

  const preview = await messageModifier.modifyMessage('0', 'NEW DISPLAY', 'manual', true);
  assert.equal(preview.metadata.requiresConfirmation, true, 'preview must be pending');

  message.swipes[message.swipe_id] = 'EXTERNAL SWIPE CHANGE';
  const confirmed = await messageModifier.confirmModification('0', true);

  assert.equal(confirmed.success, false, 'swipe text change must stale the preview');
  assert.equal(host.saveCalls, 0, 'stale preview must not save');
  assert.equal(message.swipes[0], 'EXTERNAL SWIPE CHANGE', 'external swipe text must survive');
  assert.equal(message.mes, 'RAW ORIGINAL', 'raw text remains untouched');
  assert.equal(message.extra.display_text, 'DISPLAY ORIGINAL', 'display text remains untouched');
});

// ---------------------------------------------------------------------------
// 6. Undo uses the same field ownership rules during save rejection
// ---------------------------------------------------------------------------

test('undo save rejection restores modified text but keeps metadata appended during save', { timeout: 4000 }, async () => {
  const message = messageFixture();
  message.extra = memoryExtra('DISPLAY ORIGINAL');
  host.chat = [message];

  const applied = await messageModifier.modifyMessage('0', 'MODIFIED CONTENT', 'manual', false);
  assert.equal(applied.success, true);
  assert.equal(host.saveCalls, 1);

  const save = gateSave(host);
  const pending = messageModifier.undoModification('0');
  await within(save.started, 'undo save start');

  message.extra.added_during_undo_save = { preserved: true };
  host.chatMetadata.qianqianjie = { schemaVersion: 3, appended: true };

  save.release.reject(new Error('save rejected'));
  const result = await pending;

  assert.equal(result.success, false, 'rejected undo save must fail');
  assert.equal(message.mes, 'MODIFIED CONTENT', 'modified text is rolled back after the failed undo');
  assert.equal(message.extra.display_text, 'MODIFIED CONTENT', 'modified display is rolled back after the failed undo');
  assert.equal(message.swipes[0], 'MODIFIED CONTENT', 'modified active swipe is rolled back after the failed undo');
  assert.deepEqual(message.extra.added_during_undo_save, { preserved: true }, 'undo must not remove metadata appended during save');
  assert.deepEqual(host.chatMetadata.qianqianjie, { schemaVersion: 3, appended: true }, 'undo must not remove chat metadata appended during save');
  assert.equal(host.saveCalls, 2, 'apply save plus one undo save attempt');
});
