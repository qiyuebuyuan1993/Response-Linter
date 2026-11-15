// Run: node tests/diagnostics.mjs (or node --test tests/diagnostics.mjs).
// Response Linter 1.4.13 privacy-safe diagnostics regressions.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  recordDiagnostic,
  getDiagnostics,
  clearDiagnostics,
} from '../core/diagnostics.js';

const EVENTS = [
  'host.swipe',
  'host.chat_changed',
  'host.generation_started',
  'host.generation_ended',
  'host.message_updated',
  'preview.created',
  'preview.invalidated',
  'preview.confirmed',
  'preview.rejected',
  'repair.queued',
  'repair.started',
  'repair.finished',
  'write.started',
  'write.finished',
  'diagnostics.cleared',
];

const BASE_KEYS = ['at', 'event', 'seq'];

const ALL_SAFE_FIELDS = {
  messageIndex: 4,
  swipeId: 1,
  queueLength: 0,
  pendingCount: 2,
  epoch: 1700000000000,
  durationMs: 12.5,
  rawLength: 1000,
  displayLength: 990.5,
  enabled: true,
  autoFix: false,
  streaming: true,
  success: false,
  conflict: false,
  rollbackSkipped: true,
  reason: 'repair.finished_ok',
  owner: 'response-linter',
};

beforeEach(() => {
  clearDiagnostics();
});

function currentRecords() {
  return getDiagnostics().records;
}

function lastRecord() {
  return currentRecords().at(-1);
}

test('returns the documented schema, local ISO timestamps, and monotonic seq', () => {
  assert.equal(recordDiagnostic('host.swipe', ALL_SAFE_FIELDS), true);
  assert.equal(recordDiagnostic('write.finished', { success: true, owner: 'veridis-save' }), true);

  const snapshot = getDiagnostics();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.capacity, 200);
  assert.equal(snapshot.records.length, 2);

  const [first, second] = snapshot.records;
  assert.deepEqual(first, {
    seq: first.seq,
    at: first.at,
    event: 'host.swipe',
    ...ALL_SAFE_FIELDS,
  });
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(first.at).toISOString(), first.at);
  assert.equal(second.seq, first.seq + 1);
  assert.equal(second.event, 'write.finished');
  assert.equal(second.success, true);
  assert.equal(second.owner, 'veridis-save');
});

test('accepts exactly the fixed event allowlist and ignores unknown events', () => {
  for (const event of EVENTS) {
    assert.equal(recordDiagnostic(event), true, event);
  }
  assert.deepEqual(currentRecords().map(record => record.event), EVENTS);

  const before = currentRecords().length;
  const rejected = [
    'host.swipe ',
    'host.swipe.extra',
    'HOST.SWIPE',
    'diagnostics.clear',
    '',
    null,
    123,
    Object('host.swipe'),
  ];
  for (const event of rejected) {
    assert.equal(recordDiagnostic(event, { messageIndex: 1 }), false);
  }
  assert.equal(currentRecords().length, before);
});

test('drops wrong-typed and non-finite allowlisted fields', () => {
  const rejectedValues = {
    messageIndex: Infinity,
    swipeId: NaN,
    queueLength: '7',
    pendingCount: -Infinity,
    epoch: null,
    durationMs: new Number(5),
    rawLength: true,
    displayLength: { value: 8 },
    enabled: 1,
    autoFix: 'true',
    streaming: null,
    success: new Boolean(true),
    conflict: 0,
    rollbackSkipped: undefined,
    reason: 'BAD CODE!',
    owner: 'EVIL-OWNER',
  };

  assert.equal(recordDiagnostic('repair.finished', rejectedValues), true);
  const [record] = currentRecords();
  assert.deepEqual(Object.keys(record).sort(), BASE_KEYS);
  assert.equal(record.event, 'repair.finished');
});

test('enforces safe reason codes and the fixed owner list', () => {
  const validReasons = [
    'r',
    'a'.repeat(64),
    'preview.confirmed_2',
    'repair.finished-ok',
  ];
  for (const reason of validReasons) {
    assert.equal(recordDiagnostic('repair.finished', { reason }), true);
  }
  assert.deepEqual(currentRecords().map(record => record.reason), validReasons);

  const invalidReasons = [
    '',
    'UPPER',
    'with space',
    'with/slash',
    'a'.repeat(65),
    'café',
    'ok\ncode',
    'ok\n',
    'ok\r',
    'ok\u2028',
    'ok\u2029',
    42,
    new String('valid.code'),
    null,
  ];
  for (const reason of invalidReasons) {
    assert.equal(recordDiagnostic('repair.finished', { reason }), true);
    assert.equal(Object.hasOwn(lastRecord(), 'reason'), false);
  }

  const validOwners = ['response-linter', 'veridis-rewrite', 'veridis-save', 'none', 'unknown'];
  for (const owner of validOwners) {
    assert.equal(recordDiagnostic('write.finished', { owner }), true);
    assert.equal(lastRecord().owner, owner);
  }

  const invalidOwners = [
    '',
    'response_linter',
    'EVIL',
    'none ',
    'unknown.extra',
    new String('none'),
    null,
  ];
  for (const owner of invalidOwners) {
    assert.equal(recordDiagnostic('write.finished', { owner }), true);
    assert.equal(Object.hasOwn(lastRecord(), 'owner'), false);
  }
});

test('drops hostile arbitrary fields and never serializes private text', () => {
  const secret = 'PRIVATE-CHAT-CONTENT-TOKEN-https://example.invalid';
  const hostileFields = {
    messageIndex: 10,
    enabled: false,
    reason: 'repair.ok',
    owner: 'veridis-rewrite',
    text: secret,
    content: secret,
    message: secret,
    chatName: secret,
    chatId: 987654,
    url: secret,
    apiKey: secret,
    credentials: { token: secret },
    error: new Error(secret),
    stack: secret,
    config: { secret },
    timestamp: '2026-11-12T00:00:00.000Z',
    at: '2026-11-12T00:00:00.000Z',
    seq: 999999,
    event: 'host.swipe',
  };

  assert.equal(recordDiagnostic('host.message_updated', hostileFields), true);
  const [record] = currentRecords();
  assert.equal(record.messageIndex, 10);
  assert.equal(record.enabled, false);
  assert.equal(record.reason, 'repair.ok');
  assert.equal(record.owner, 'veridis-rewrite');
  assert.equal(record.event, 'host.message_updated');

  for (const name of ['text', 'content', 'message', 'chatName', 'chatId', 'url', 'apiKey',
    'credentials', 'error', 'stack', 'config', 'timestamp']) {
    assert.equal(Object.hasOwn(record, name), false);
  }
  assert.ok(Number.isSafeInteger(record.seq));
  assert.equal(new Date(record.at).toISOString(), record.at);
  assert.deepEqual(
    Object.keys(record).sort(),
    [...BASE_KEYS, 'enabled', 'messageIndex', 'owner', 'reason'].sort(),
  );
  assert.equal(JSON.stringify(getDiagnostics()).includes(secret), false);
});

test('does not invoke inherited or accessor fields and survives hostile proxies', () => {
  let getterCalls = 0;
  const fields = Object.create({ messageIndex: 77, reason: 'inherited.code' });
  fields.swipeId = 2;
  Object.defineProperty(fields, 'reason', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'repair.ok';
    },
  });
  Object.defineProperty(fields, 'owner', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'response-linter';
    },
  });

  assert.equal(recordDiagnostic('host.swipe', fields), true);
  const record = lastRecord();
  assert.equal(getterCalls, 0);
  assert.equal(record.swipeId, 2);
  assert.equal(Object.hasOwn(record, 'messageIndex'), false);
  assert.equal(Object.hasOwn(record, 'reason'), false);
  assert.equal(Object.hasOwn(record, 'owner'), false);

  const proxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error('hostile descriptor trap');
    },
  });
  assert.doesNotThrow(() => recordDiagnostic('preview.created', proxy));
  assert.deepEqual(Object.keys(lastRecord()).sort(), BASE_KEYS);
});

test('rejects prototype-pollution keys without mutating Object.prototype', () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":"SECRET"},"constructor":{"prototype":{"polluted":"SECRET"}},'
    + '"messageIndex":9,"text":"SECRET"}',
  );
  assert.equal(recordDiagnostic('host.message_updated', hostile), true);
  const record = lastRecord();

  assert.equal({}.polluted, undefined);
  assert.equal(record.messageIndex, 9);
  assert.equal(Object.hasOwn(record, '__proto__'), false);
  assert.equal(Object.hasOwn(record, 'constructor'), false);
  assert.equal(Object.hasOwn(record, 'text'), false);
});

test('keeps a detached 200-record ring and wraps to the newest records', () => {
  for (let index = 0; index < 250; index += 1) {
    assert.equal(recordDiagnostic('repair.queued', {
      messageIndex: index,
      queueLength: 250 - index,
    }), true);
  }

  const snapshot = getDiagnostics();
  assert.equal(snapshot.records.length, 200);
  assert.equal(snapshot.records[0].messageIndex, 50);
  assert.equal(snapshot.records.at(-1).messageIndex, 249);
  for (let index = 1; index < snapshot.records.length; index += 1) {
    assert.equal(snapshot.records[index].seq, snapshot.records[index - 1].seq + 1);
  }

  const inputFields = { messageIndex: 3, reason: 'repair.ok' };
  recordDiagnostic('preview.created', inputFields);
  inputFields.messageIndex = 999;
  inputFields.reason = 'tampered.code';
  inputFields.privateText = 'not copied';

  const first = getDiagnostics();
  const storedRecord = first.records.at(-1);
  assert.equal(storedRecord.messageIndex, 3);
  assert.equal(storedRecord.reason, 'repair.ok');
  storedRecord.messageIndex = 777;
  storedRecord.event = 'tampered.event';
  storedRecord.owner = 'tampered.owner';
  first.records.push({ seq: -1, at: 'not-a-time', event: 'host.swipe' });
  first.schemaVersion = 99;
  first.capacity = 1;

  const second = getDiagnostics();
  assert.equal(second.schemaVersion, 1);
  assert.equal(second.capacity, 200);
  assert.equal(second.records.length, 200);
  assert.equal(second.records.at(-1).messageIndex, 3);
  assert.equal(second.records.at(-1).reason, 'repair.ok');
  assert.equal(second.records.at(-1).event, 'preview.created');
  assert.equal(Object.hasOwn(second.records.at(-1), 'owner'), false);
  assert.notStrictEqual(first.records, second.records);
  assert.notStrictEqual(storedRecord, second.records.at(-1));
});

test('clear empties the ring while retaining the monotonic sequence counter', () => {
  recordDiagnostic('repair.started');
  recordDiagnostic('repair.finished', { success: true });
  const previousSeq = lastRecord().seq;

  clearDiagnostics();
  const empty = getDiagnostics();
  assert.equal(empty.records.length, 0);
  assert.equal(empty.capacity, 200);
  assert.equal(empty.schemaVersion, 1);

  recordDiagnostic('write.started');
  const [record] = currentRecords();
  assert.equal(record.seq, previousSeq + 1);
});

test('recorder uses no imports, logging, disk, or network APIs', () => {
  const source = readFileSync(new URL('../core/diagnostics.js', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  assert.doesNotMatch(code, /\b(?:import|require)\b/);
  assert.doesNotMatch(
    code,
    /\b(?:console|process|fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon|localStorage|sessionStorage|indexedDB|BroadcastChannel|Worker|Buffer)\b/,
  );
  assert.doesNotMatch(
    code,
    /\b(?:fs|http|https|net|tls|dns|dgram|child_process|writeFile|appendFile|createWriteStream)\b/,
  );
});

test('recording, reading, and clearing make no console or network calls', () => {
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'];
  const originals = new Map();
  let consoleCalls = 0;
  for (const method of consoleMethods) {
    originals.set(method, console[method]);
    console[method] = () => {
      consoleCalls += 1;
    };
  }

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network disabled during diagnostics test');
  };

  try {
    recordDiagnostic('preview.created', {
      messageIndex: 1,
      reason: 'preview.ok',
      owner: 'response-linter',
    });
    getDiagnostics();
    clearDiagnostics();
  } finally {
    for (const method of consoleMethods) {
      console[method] = originals.get(method);
    }
    globalThis.fetch = originalFetch;
  }

  assert.equal(consoleCalls, 0);
  assert.equal(networkCalls, 0);
});
