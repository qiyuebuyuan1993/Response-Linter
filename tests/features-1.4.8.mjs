// Run: node --test tests/*.mjs (Node.js 22.15+/24) or node tests/features-1.4.8.mjs
// 1.4.8 tests: versioned structure profiles, custom body/time/trailing blocks,
// automatic read-only calendar awareness, Quick Reply install idempotence and
// realistic memory-plugin metadata preservation.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

globalThis.window = globalThis;
globalThis.document = new EventTarget();
document.createElement = () => ({ textContent: '', get innerHTML() { return this.textContent; } });
globalThis.__testContext = {
  chat: [],
  extensionSettings: {},
  chatMetadata: {},
  streamingProcessor: null,
  eventSource: null,
  saveChat: async () => {},
};
globalThis.getContext = () => globalThis.__testContext;
globalThis.SillyTavern = { getContext };
globalThis.ResponseLinter = {};

test('explicit profile import replaces cached drafts while ordinary refresh preserves unsaved edits', async () => {
  const { StructureProfileUI } = await import('../presentation/modules/structure-profile-ui.js');
  const { createBlankProfile } = await import('../core/structure-profiles.js');
  const ui = new StructureProfileUI();
  const stored = createBlankProfile({ id: 'draft-import', name: '导入后的方案' });
  ui.getSettings = () => ({ structureProfilesVersion: 1, structureProfiles: [stored], structureProfileId: stored.id });
  ui.renderSelect = () => {};
  ui.renderEditor = () => {};
  ui.currentDraft = { ...stored, name: '切换前的旧草稿' };
  ui.currentDraftId = stored.id;
  ui.drafts.set(stored.id, ui.currentDraft);
  ui.refreshFromSettings({ preserveDraft: false });
  assert.equal(ui.currentDraft.name, '导入后的方案');
  assert.equal(ui.drafts.size, 0);

  ui.dirty = true;
  ui.captureDraftFromForm = () => ({ ...stored, name: '尚未保存的编辑' });
  ui.refreshFromSettings({ preserveDraft: true });
  assert.equal(ui.currentDraft.name, '尚未保存的编辑');
  assert.equal(ui.dirty, true);
});

const {
  LEGACY_PROFILE_ID,
  STRUCTURE_PROFILES_VERSION,
  buildProfileAnchorPatterns,
  compileMarkerTemplate,
  createBlankProfile,
  createLegacyProfile,
  mergeStructureProfiles,
  migrateStructureProfileSettings,
  readStructureProfiles,
  validateMarkerTemplate,
  validateStructureProfile,
} = await import('../core/structure-profiles.js');
const {
  repairProfileBodyBoundary,
  repairProfileTrailingBlocks,
  repairWithProfile,
  synthesizeProfileTimeEnd,
} = await import('../core/structure-repair.js');
const {
  repairSdcContent,
} = await import('../core/sdc-boundary.js');
const {
  FOUR_SEASONS_28,
  resolveCalendarSource,
} = await import('../core/calendar-engine.js');
const {
  transformContent,
  normalizeRepairSettings,
} = await import('../core/repair-service.js');
const {
  sanitizeLeakedReasoning,
} = await import('../core/reasoning-sanitizer.js');
const {
  escapeHtmlText,
  formatErrorForToast,
} = await import('../core/text-safety.js');
const { StructureProfileUI } = await import('../presentation/modules/structure-profile-ui.js');
const {
  createStructureSettingsExport,
  importStructureSettingsText,
} = await import('../core/settings-transfer.js');
const {
  resolveCalendarAwareness,
  watchCalendarAwareness,
  GOUHUA_CALENDAR_CHANGED_EVENT,
} = await import('../core/calendar-awareness.js');
const {
  RESPONSE_LINTER_COMMAND_NAME,
  registerQuickReplyCommand,
} = await import('../core/quick-reply-command.js');
const {
  QUICK_REPLY_ITEM_LABEL,
  QUICK_REPLY_ITEM_TITLE_MARKER,
  createQuickReplyInstaller,
  defaultQuickReplyInstallState,
  startQuickReplyReadiness,
} = await import('../core/quick-reply-installer.js');
const { quickReplyDescriptor } = await import('../core/quick-reply-descriptor.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { messageModifier } = await import('../core/message-modifier.js');
const { createBackendController } = await import('../core/backend-controller.js');

const controller = createBackendController('response-linter');
controller.start = () => { controller.isRunning = true; };
fixCoordinator._sleep = async () => {};

const CN_START = '【开始：{date}·{weekday}·{time}】';
const CN_END = '【结束：{date}·{weekday}·{time}】';
const customTimeProfile = (overrides = {}) => validateStructureProfile({
  version: STRUCTURE_PROFILES_VERSION,
  id: 'custom-time',
  name: '自定义时间结构',
  body: { open: '<正文>', close: '</正文>' },
  time: { mode: 'custom', startTemplate: CN_START, endTemplate: CN_END },
  auxiliaries: ['【水印】'],
  blocks: [
    { id: 'monologue', label: '内心独白', open: '<内心独白>', close: '</内心独白>' },
    { id: 'choices', label: '选项', open: '<选项>', close: '</选项>' },
  ],
  ...overrides,
}).profile;

const plainProfile = (overrides = {}) => validateStructureProfile({
  version: STRUCTURE_PROFILES_VERSION,
  id: 'plain-custom',
  name: '无时间自定义结构',
  body: { open: '【正文】', close: '【/正文】' },
  time: { mode: 'none' },
  auxiliaries: ['【水印】'],
  blocks: [
    { id: 'a', label: 'A', open: '【选项】', close: '【/选项】' },
    { id: 'b', label: 'B', open: '【内心】', close: '【/内心】' },
    { id: 'c', label: 'C', open: '【状态】', close: '【/状态】' },
  ],
  ...overrides,
}).profile;

let saves;
const originalFixtures = [];

function messageFixture(mes, { swipe = mes, extra = {} } = {}) {
  return { mes, is_user: false, swipe_id: 0, swipes: [swipe], extra: { display_text: mes, ...extra } };
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
  __testContext.chat = [];
  __testContext.extensionSettings = {};
  __testContext.chatMetadata = {};
  __testContext.streamingProcessor = null;
  __testContext.eventSource = { emit() { this.emitted = (this.emitted || 0) + 1; }, emitted: 0 };
  __testContext.updateMessageBlock = async id => { await messageHandler._handleMessageRendered(String(id)); };
  __testContext.saveChat = async () => { saves++; };
  saves = 0;
  globalThis.UIState = { rules: [] };
  controller.resetStatistics();
});

// ===== profiles / migration / settings =====

test('old settings migrate to a versioned legacy profile without resetting rules, flags or keywords', () => {
  const old = {
    enabled: true,
    autoFix: false,
    rules: [{ id: 'legacy', name: '旧规则', enabled: false, requiredContent: ['<content>'] }],
    removeLeakedReasoning: true,
    repairSdcBoundary: true,
    repairDetailsOrder: true,
    detailsMonologueKeyword: '心声',
    detailsChoicesKeyword: '抉择',
    sdcCalendarSource: 'four-seasons-28',
    sdcAdvanceMinutes: 15,
    untouched: 'keep',
  };
  const before = structuredClone(old);
  const migrated = migrateStructureProfileSettings(old);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.fields.structureProfiles.length, 1);
  assert.equal(migrated.fields.structureProfileId, LEGACY_PROFILE_ID);
  const legacy = migrated.fields.structureProfiles[0];
  assert.equal(legacy.builtin, true);
  assert.equal(legacy.time.mode, 'sdc');
  assert.deepEqual(legacy.blocks.map(block => block.id), ['monologue', 'choices']);
  assert.deepEqual(legacy.blocks.map(block => block.titleKeyword), ['心声', '抉择']);
  assert.equal(old.rules[0].enabled, false);
  assert.equal(old.repairSdcBoundary, true);
  assert.equal(old.sdcAdvanceMinutes, 15);
  assert.equal(old.untouched, 'keep');
  assert.deepEqual(old.rules, before.rules);
  const read = readStructureProfiles(old);
  assert.equal(read.migrated, true);
  assert.equal(read.activeProfileId, LEGACY_PROFILE_ID);
});

test('valid custom profiles are selected and invalid editor input cannot overwrite the previous valid collection', () => {
  const previous = {
    structureProfiles: [createLegacyProfile({})],
    structureProfileId: LEGACY_PROFILE_ID,
  };
  const custom = plainProfile();
  const merged = mergeStructureProfiles(previous, {
    structureProfiles: [createLegacyProfile({}), custom],
    structureProfileId: custom.id,
  });
  assert.equal(merged.rejected, false);
  assert.equal(merged.fields.structureProfileId, 'plain-custom');
  assert.equal(merged.fields.structureProfiles.length, 2);

  for (const invalid of [
    {
      structureProfiles: [createLegacyProfile({}), { ...custom, body: { open: '', close: '</正文>' } }],
      structureProfileId: custom.id,
    },
    {
      structureProfiles: [createLegacyProfile({}), { ...custom, id: LEGACY_PROFILE_ID }],
      structureProfileId: custom.id,
    },
    {
      structureProfiles: [createLegacyProfile({}), custom],
      structureProfileId: 'missing',
    },
    { structureProfiles: [], structureProfileId: LEGACY_PROFILE_ID },
  ]) {
    const result = mergeStructureProfiles(previous, invalid);
    assert.equal(result.rejected, true);
    assert.equal(result.fields.structureProfileId, LEGACY_PROFILE_ID);
    assert.deepEqual(result.fields.structureProfiles, [createLegacyProfile({})]);
  }
});

test('custom time templates require exactly one date/weekday/time and reject ambiguity or delimiter conflicts', () => {
  assert.equal(validateMarkerTemplate(CN_START).ok, true);
  assert.equal(validateMarkerTemplate('{date}{weekday}{time}').ok, false);
  assert.equal(validateMarkerTemplate('【{date}·{weekday}】').ok, false);
  assert.equal(validateMarkerTemplate('【{date}·{weekday}·{time}·{date}】').ok, false);
  assert.equal(validateMarkerTemplate('【{date}·{weekday}·{time}·{evil}】').ok, false);
  const compiled = compileMarkerTemplate(CN_START);
  const match = compiled.exec('【开始：1年冬28日·周日·23:50】');
  assert.deepEqual({ ...match.groups }, { date: '1年冬28日', weekday: '周日', time: '23:50' });

  const conflict = validateStructureProfile({
    id: 'conflict',
    name: '冲突',
    body: { open: '<正文>', close: '</正文>' },
    time: { mode: 'custom', startTemplate: CN_START, endTemplate: CN_END },
    auxiliaries: [CN_START],
    blocks: [{ id: 's', label: '状态', open: '<状态栏>', close: '</状态栏>' }],
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /冲突/);
});

test('marker matching preserves placeholder order, requires all three values and stays case-exact by default', () => {
  const reordered = compileMarkerTemplate('[BEGIN {weekday}|{date}|{time}]');
  const match = reordered.exec('[BEGIN 周五|1年夏5日|12:20]');
  assert.deepEqual({ ...match.groups }, { weekday: '周五', date: '1年夏5日', time: '12:20' });
  assert.equal(match[0], '[BEGIN 周五|1年夏5日|12:20]');

  const ordered = compileMarkerTemplate('[BEGIN {date}|{weekday}|{time}]');
  assert.equal(ordered.exec('[BEGIN 1年夏5日|周五]'), null);
  assert.equal(ordered.exec('[begin 1年夏5日|周五|12:20]'), null);
  assert.equal(ordered.exec('[BEGIN 1年夏5日|周五|12:20]').groups.time, '12:20');
  const insensitive = compileMarkerTemplate('[BEGIN {date}|{weekday}|{time}]', 'gi');
  assert.equal(insensitive.exec('[begin 1年夏5日|周五|12:20]').groups.date, '1年夏5日');
});

test('malformed 8 KB markers and reasoning anchors finish without catastrophic backtracking', async () => {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const [{ compileMarkerTemplate, buildProfileAnchorPatterns }, { sanitizeLeakedReasoning }] = await Promise.all([
        import(workerData.profilesUrl),
        import(workerData.sanitizerUrl),
      ]);
      const malformed = '[BEGIN ' + 'x|'.repeat(4000);
      const started = performance.now();
      const marker = compileMarkerTemplate('[BEGIN {date}|{weekday}|{time}]').exec(malformed);
      const cleaned = sanitizeLeakedReasoning('<thinking>泄漏' + malformed, {
        anchorPatterns: buildProfileAnchorPatterns({
          body: { open: '<content>', close: '</content>' },
          time: { mode: 'custom', startTemplate: '[BEGIN {date}|{weekday}|{time}]' },
        }),
        useDefaultAnchorPatterns: false,
      });
      parentPort.postMessage({
        elapsed: performance.now() - started,
        markerMissing: marker === null,
        reasoningPreserved: cleaned.content === '<thinking>泄漏' + malformed,
      });
    })().catch(error => parentPort.postMessage({ error: error.message }));
  `;
  const worker = new Worker(workerCode, {
    eval: true,
    workerData: {
      profilesUrl: new URL('../core/structure-profiles.js', import.meta.url).href,
      sanitizerUrl: new URL('../core/reasoning-sanitizer.js', import.meta.url).href,
    },
  });
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 3000);
    worker.once('message', value => { clearTimeout(timer); resolve(value); });
    worker.once('error', error => { clearTimeout(timer); resolve({ error: error.message }); });
  });
  await worker.terminate();
  assert.equal(outcome.timedOut, undefined, 'marker/reasoning scan exceeded 3 seconds');
  assert.equal(outcome.error, undefined, outcome.error);
  assert.equal(outcome.markerMissing, true);
  assert.equal(outcome.reasoningPreserved, true);
  assert.ok(outcome.elapsed < 2000, `malformed marker scan took ${outcome.elapsed}ms`);
});

test('profile import/export round-trips and backward-compatible imports preserve existing profiles atomically', () => {
  const legacy = createLegacyProfile({ detailsMonologueKeyword: '心声', detailsChoicesKeyword: '抉择' });
  const custom = customTimeProfile();
  const previous = {
    structureProfilesVersion: 1,
    structureProfiles: [legacy, custom],
    structureProfileId: custom.id,
    removeLeakedReasoning: true,
    repairSdcBoundary: true,
    repairDetailsOrder: true,
    detailsMonologueKeyword: '心声',
    detailsChoicesKeyword: '抉择',
    sdcCalendarSource: 'four-seasons-28',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 15,
  };
  const exported = createStructureSettingsExport(previous);
  assert.equal(exported.structureProfiles.length, 2);
  assert.equal(exported.structureProfileId, custom.id);
  const roundTrip = importStructureSettingsText(JSON.stringify(exported), previous);
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(roundTrip.settings.structureProfiles, exported.structureProfiles);
  assert.equal(roundTrip.settings.structureProfileId, custom.id);
  assert.equal(roundTrip.settings.sdcAdvanceMinutes, 15);

  const oldExport = JSON.stringify({
    format: 'response-linter-structure-settings',
    version: 1,
    removeLeakedReasoning: false,
    repairSdcBoundary: false,
    sdcCalendarSource: 'four-seasons-28',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 20,
  });
  const oldImport = importStructureSettingsText(oldExport, previous);
  assert.equal(oldImport.ok, true);
  assert.deepEqual(oldImport.settings.structureProfiles, previous.structureProfiles);
  assert.equal(oldImport.settings.structureProfileId, previous.structureProfileId);

  const before = structuredClone(previous);
  const badCases = [
    { structureProfiles: [custom, custom], structureProfileId: custom.id },
    { structureProfiles: [custom], structureProfileId: 'missing' },
    { structureProfiles: [{ ...custom, name: '' }], structureProfileId: custom.id },
    { structureProfiles: [{ ...custom, time: { mode: 'custom', startTemplate: CN_START, endTemplate: CN_START } }], structureProfileId: custom.id },
  ];
  for (const bad of badCases) {
    const result = importStructureSettingsText(JSON.stringify(bad), previous);
    assert.equal(result.ok, false);
    assert.equal(result.settings, undefined);
  }
  const polluted = importStructureSettingsText(
    '{"structureProfiles":[{"id":"x","name":"x","body":{"open":"<x>","close":"</x>","__proto__":{"polluted":true}},"time":{"mode":"none"},"blocks":[]}],"structureProfileId":"x"}',
    previous,
  );
  assert.equal(polluted.ok, false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(previous, before);

  const directCalendar = importStructureSettingsText(JSON.stringify({
    months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }],
    weekdayCycle: 7,
    dateFormat: '{year}年{month}{day}日',
    advanceMinutes: 30,
  }), previous);
  assert.equal(directCalendar.ok, true);
  assert.equal(directCalendar.settings.sdcCalendarSource, 'custom');
  assert.deepEqual(directCalendar.settings.structureProfiles, before.structureProfiles);
});

test('malicious imported profile text is escaped for toast and editor errors use textContent', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const first = createBlankProfile({ id: 'malicious-1', name: malicious });
  const second = createBlankProfile({ id: 'malicious-2', name: malicious });
  const imported = importStructureSettingsText(JSON.stringify({
    structureProfiles: [first, second],
    structureProfileId: first.id,
  }), {});
  assert.equal(imported.ok, false);
  assert.ok(imported.error.includes(malicious), 'fixture must reflect the imported field in the error');

  const toastHtml = formatErrorForToast('导入失败：', new Error(imported.error));
  assert.equal(toastHtml.includes('<img'), false);
  assert.ok(toastHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(toastHtml, `导入失败：${escapeHtmlText(imported.error)}`);

  const element = {
    textContent: '',
    innerHTML: '<b>unchanged</b>',
    classList: { toggle() {} },
  };
  const originalGetElementById = document.getElementById;
  document.getElementById = id => (id === 'rl-profile-messages' ? element : null);
  try {
    const ui = new StructureProfileUI();
    ui.setMessage(`导入失败：${imported.error}`, true);
    assert.equal(element.textContent, `导入失败：${imported.error}`);
    assert.equal(element.innerHTML, '<b>unchanged</b>');
  } finally {
    if (originalGetElementById) document.getElementById = originalGetElementById;
    else delete document.getElementById;
  }
});

// ===== body / time boundary =====

test('time mode none repairs a custom body pair before the first external marker without requiring a calendar', () => {
  const profile = plainProfile();
  const source = '【正文】正文\n【选项】one【/选项】\n中间\n【状态】three【/状态】\n【内心】two【/内心】\n【水印】logo\n【/正文】';
  const result = repairWithProfile(source, profile, {
    bodyBoundaryEnabled: true,
    trailingOrderEnabled: false,
    resolveCalendar: () => { throw new Error('calendar must not be read in none mode'); },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.content.indexOf('【/正文】') < result.content.indexOf('【水印】'));
  assert.ok(result.content.indexOf('【/正文】') < result.content.indexOf('【选项】'));
  assert.ok(result.content.includes('中间'));
});

test('custom literal body boundary is exact, while HTML tag body opens accept attributes and case changes', () => {
  const literalProfile = plainProfile({ auxiliaries: ['【水印】'], blocks: [] });
  const literal = '【正文】正文【/正文】\n【水印】logo';
  assert.equal(repairProfileBodyBoundary(literal, literalProfile, {}).changed, false);

  const htmlProfile = validateStructureProfile({
    id: 'html-none', name: 'HTML 无时间', body: { open: '<正文>', close: '</正文>' },
    time: { mode: 'none' }, auxiliaries: ['【水印】'], blocks: [],
  }).profile;
  const source = '<正文>正文\n【水印】logo\n</正文>';
  assert.equal(repairProfileBodyBoundary(source, htmlProfile, {}).changed, true);

  const bodyTagProfile = validateStructureProfile({
    id: 'tag-body', name: '标签正文', body: { open: '<content>', close: '</content>' }, time: { mode: 'none' },
    auxiliaries: ['<状态栏>'], blocks: [],
  }).profile;
  const withAttrs = '<CONTENT class="x">正文<状态栏>state</状态栏></CONTENT>';
  const repaired = repairProfileBodyBoundary(withAttrs, bodyTagProfile, {});
  assert.equal(repaired.changed, true);
  assert.ok(repaired.content.indexOf('</CONTENT>') < repaired.content.indexOf('<状态栏>'));
});

test('custom timestamp end is moved byte-for-byte and does not read the calendar; missing end is synthesized across year', () => {
  const profile = customTimeProfile();
  const start = '【开始：1年冬28日·周日·23:50】';
  const existingEnd = '【结束：1年冬28日·周日·23:59】';
  const source = `<正文>\n${start}\n正文\n${existingEnd}\n【水印】logo\n</正文>`;
  let reads = 0;
  const moved = repairProfileBodyBoundary(source, profile, {
    resolveCalendar: () => { reads++; throw new Error('must not read'); },
  });
  assert.equal(moved.changed, true);
  assert.equal(reads, 0);
  assert.equal(moved.content.includes(existingEnd), true);
  assert.equal(moved.content.split(existingEnd).length - 1, 1);
  assert.ok(moved.content.indexOf(existingEnd) < moved.content.indexOf('【水印】'));

  const missing = `<正文>\n${start}\n正文\n【水印】logo\n</正文>`;
  const synthesized = repairProfileBodyBoundary(missing, profile, {
    calendar: FOUR_SEASONS_28,
    advanceMinutes: 10,
  });
  assert.equal(synthesized.changed, true);
  assert.equal(synthesized.warnings.length, 0);
  assert.ok(synthesized.content.includes('【结束：2年春1日·周一·00:00】'));
  assert.ok(synthesized.content.includes('【开始：1年冬28日·周日·23:50】'));
  assert.ok(synthesized.content.indexOf('【结束：2年春1日·周一·00:00】') < synthesized.content.indexOf('【水印】'));
});

test('invalid custom timestamp fields preserve the reply and warn instead of guessing', () => {
  const profile = customTimeProfile();
  const source = '<正文>\n【开始：乱写日期·周日·23:50】\n正文\n</正文>';
  const result = repairProfileBodyBoundary(source, profile, { calendar: FOUR_SEASONS_28, advanceMinutes: 10 });
  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.ok(result.warnings.some(item => /手动补全|不符合|无效/.test(item)));
  assert.ok(!result.content.includes('【结束：'));
});

test('duplicate body/time markers conservatively warn and preserve original text', () => {
  const profile = customTimeProfile();
  const duplicateStart = `<正文>\n【开始：1年夏1日·周一·10:00】\n【开始：1年夏1日·周一·10:01】\n正文\n【水印】x\n</正文>`;
  const result = repairProfileBodyBoundary(duplicateStart, profile, { calendar: FOUR_SEASONS_28 });
  assert.equal(result.changed, false);
  assert.equal(result.content, duplicateStart);
  assert.ok(result.warnings.some(item => /重复/.test(item)));

  const duplicateBody = '<正文>a</正文>b</正文>';
  const bodyResult = repairProfileBodyBoundary(duplicateBody, profile, { calendar: FOUR_SEASONS_28 });
  assert.equal(bodyResult.changed, false);
  assert.ok(bodyResult.warnings.some(item => /重复/.test(item)));
});

test('protected code and HTML-comment examples are not treated as real body/time markers', () => {
  const profile = customTimeProfile();
  const source = '<正文>\n```html\n【开始：1年夏1日·周一·10:00】\n</正文>\n```\n<!-- 示例 <正文> <正文> 【开始：1年夏1日·周一·10:01】 -->\n正文\n</正文>';
  const result = repairProfileBodyBoundary(source, profile, { calendar: FOUR_SEASONS_28 });
  assert.equal(result.changed, false);
  assert.ok(result.content.includes('<!-- 示例'));
});

// ===== trailing blocks =====

test('three arbitrary configured blocks reorder into profile order while unknown blocks and text stay byte-for-byte', () => {
  const profile = plainProfile();
  const unknown = '<details><summary>未知</summary>keep</details>';
  const source = '【正文】正文\n【/正文】\n【选项】opt【/选项】\n中间文字\n【状态】status【/状态】\n' + unknown + '\n【内心】mono【/内心】\n末尾附加';
  const result = repairProfileTrailingBlocks(source, profile, {});
  assert.equal(result.changed, true);
  assert.ok(result.content.indexOf('【选项】') < result.content.indexOf('【内心】'));
  assert.ok(result.content.indexOf('【内心】') < result.content.indexOf('【状态】'));
  assert.ok(result.content.includes('中间文字'));
  assert.ok(result.content.includes(unknown));
  assert.ok(result.content.endsWith('末尾附加'));
});

test('balanced nested target blocks are not flattened or promoted, and missing close needs clear sibling evidence', () => {
  const profile = plainProfile();
  const nested = '【正文】正文【/正文】\n【选项】outer\n【内心】inner【/内心】\n【/选项】\n【状态】status【/状态】';
  const result = repairProfileTrailingBlocks(nested, profile, {});
  assert.equal(result.changed, false);
  assert.equal(result.content, nested, 'nested target remains nested; no flattening or promotion');
  assert.equal(result.repairs.length, 0);

  const siblingProfile = validateStructureProfile({
    ...profile,
    id: 'sibling-order',
    name: '同标签缺失闭合顺序',
    blocks: [profile.blocks[1], profile.blocks[0], profile.blocks[2]],
  }).profile;
  const repairable = '【正文】正文【/正文】\n【选项】opt\n【内心】mono【/内心】';
  const repaired = repairProfileTrailingBlocks(repairable, siblingProfile, {});
  assert.equal(repaired.changed, true);
  assert.ok(repaired.repairs.includes('inserted-block-close'));
  assert.equal((repaired.content.match(/【\/选项】/g) || []).length, 1);
  assert.ok(repaired.content.indexOf('【内心】') < repaired.content.indexOf('【选项】'));

  const noEvidence = '【正文】正文【/正文】\n<unknown>outer【选项】opt【/选项】';
  const preserved = repairProfileTrailingBlocks(noEvidence, profile, {});
  assert.equal(preserved.changed, false);
  assert.ok(preserved.warnings.some(item => /未闭合|归属/.test(item)));
});

test('same-tag blocks use direct title elements and ambiguous titles are preserved with warnings', () => {
  const sameTag = validateStructureProfile({
    id: 'same-tag',
    name: '同标签',
    body: { open: '<正文>', close: '</正文>' },
    time: { mode: 'none' },
    blocks: [
      { id: 'mono', label: '独白', open: '<details>', close: '</details>', titleTag: 'summary', titleKeyword: '独白' },
      { id: 'choice', label: '选项', open: '<details>', close: '</details>', titleTag: 'summary', titleKeyword: '选项' },
    ],
  }).profile;
  const source = '<正文>正文</正文>\n<details><summary>选项</summary>c</details>\n<details><summary>独白</summary>m</details>';
  const result = repairProfileTrailingBlocks(source, sameTag, {});
  assert.equal(result.changed, true);
  assert.ok(result.content.indexOf('独白') < result.content.indexOf('选项'));

  const ambiguous = '<正文>正文</正文>\n<details><summary>独白 选项</summary>both</details>\n<details><summary>独白</summary>m</details>';
  const preserved = repairProfileTrailingBlocks(ambiguous, sameTag, {});
  assert.equal(preserved.changed, false);
  assert.ok(preserved.warnings.some(item => /歧义|多个/.test(item)));
});

test('code fences, inline code, code/pre and comments hide target examples from reordering', () => {
  const profile = plainProfile();
  const examples = [
    '```txt',
    '【选项】example【/选项】',
    '```',
    '`【内心】inline【/内心】`',
    '<code>【状态】code【/状态】</code>',
    '<pre>【选项】pre【/选项】</pre>',
    '<!-- 【内心】comment【/内心】 -->',
  ].join('\n');
  const source = `【正文】正文【/正文】\n${examples}\n【状态】realStatus【/状态】\n【选项】real【/选项】\n【内心】realMono【/内心】`;
  const result = repairProfileTrailingBlocks(source, profile, {});
  assert.equal(result.changed, true);
  for (const snippet of ['example', 'inline', 'code', 'pre', 'comment', 'realMono', 'realStatus']) {
    assert.ok(result.content.includes(snippet));
  }
  assert.ok(result.content.indexOf('【选项】real') < result.content.indexOf('【内心】realMono'));
  assert.ok(result.content.indexOf('【内心】realMono') < result.content.indexOf('【状态】realStatus'));
});

test('trailing-only repair never moves body boundaries and warns when targets are still inside the body', () => {
  const profile = plainProfile();
  const source = '【正文】正文\n【选项】a【/选项】\n【内心】b【/内心】\n【/正文】';
  const result = repairWithProfile(source, profile, {
    bodyBoundaryEnabled: false,
    trailingOrderEnabled: true,
    resolveCalendar: () => { throw new Error('no calendar expected'); },
  });
  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.ok(result.warnings.some(item => /正文结束分隔符|正文边界/.test(item)));
});

test('body-boundary switch alone does not reorder blocks; profile repair is idempotent', () => {
  const profile = plainProfile();
  const source = '【正文】正文\n【内心】b【/内心】\n【选项】a【/选项】\n【水印】logo\n【/正文】';
  const boundaryOnly = repairWithProfile(source, profile, { bodyBoundaryEnabled: true });
  assert.equal(boundaryOnly.changed, true);
  assert.equal(boundaryOnly.trailing, null);
  assert.ok(boundaryOnly.content.indexOf('【内心】') < boundaryOnly.content.indexOf('【选项】'));
  const both = repairWithProfile(boundaryOnly.content, profile, {
    bodyBoundaryEnabled: true,
    trailingOrderEnabled: true,
  });
  assert.equal(both.changed, true);
  assert.ok(both.content.indexOf('【选项】') < both.content.indexOf('【内心】'));
  const idempotent = repairWithProfile(both.content, profile, {
    bodyBoundaryEnabled: true,
    trailingOrderEnabled: true,
  });
  assert.equal(idempotent.changed, false);
});

// ===== reasoning anchors =====

test('unclosed reasoning uses custom body/time anchors and never falls back to unrelated legacy anchors', () => {
  const profile = customTimeProfile();
  const anchors = buildProfileAnchorPatterns(profile);
  const source = '<thinking>泄漏\n【开始：1年夏1日·周一·10:00】\n正文';
  const cleaned = sanitizeLeakedReasoning(source, {
    anchorPatterns: anchors,
    useDefaultAnchorPatterns: false,
  });
  assert.equal(cleaned.changed, true);
  assert.ok(cleaned.content.startsWith('【开始：1年夏1日·周一·10:00】'));

  const customBody = '<thinking>泄漏\n<正文>正文';
  const cleanedBody = sanitizeLeakedReasoning(customBody, {
    anchorPatterns: buildProfileAnchorPatterns(customTimeProfile()),
    useDefaultAnchorPatterns: false,
  });
  assert.equal(cleanedBody.content, '<正文>正文');

  const legacyAnchorOnly = '<thinking>不确定\n<content>不应作为自定义档案的锚点';
  const kept = sanitizeLeakedReasoning(legacyAnchorOnly, {
    anchorPatterns: buildProfileAnchorPatterns(customTimeProfile()),
    useDefaultAnchorPatterns: false,
  });
  assert.equal(kept.changed, false);
  assert.equal(kept.content, legacyAnchorOnly);
});

// ===== calendar awareness =====

test('calendar awareness is read-only, refreshes per chat and never replaces explicit preset/custom selections', () => {
  const profile = createLegacyProfile({});
  const settings = {
    structureProfiles: [profile],
    structureProfileId: profile.id,
    sdcCalendarSource: 'gouhua',
  };
  const ctxOne = { chatMetadata: { 'sp-store': { data: { 'caldesc-user': { kind: 'custom', weekdayCycle: 7, months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }] } } } } };
  const ctxTwo = { chatMetadata: { 'sp-store': { data: { 'caldesc-user': { kind: 'custom', weekdayCycle: 7, months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }, { name: '秋', days: 28 }] } } } } };
  const snapshot = structuredClone(ctxOne.chatMetadata);
  const first = resolveCalendarAwareness(settings, ctxOne);
  assert.equal(first.ok, true);
  assert.equal(first.automatic, true);
  assert.deepEqual(ctxOne.chatMetadata, snapshot);
  const second = resolveCalendarAwareness(settings, ctxTwo);
  assert.equal(second.ok, true);
  assert.equal(second.calendar.months.length, 3);

  const explicit = resolveCalendarAwareness({ ...settings, sdcCalendarSource: 'four-seasons-28' }, ctxOne);
  assert.equal(explicit.source, 'four-seasons-28');
  assert.equal(explicit.automatic, false);

  const noneProfile = validateStructureProfile({
    id: 'none', name: '无时间', body: { open: '<x>', close: '</x>' }, time: { mode: 'none' }, blocks: [],
  }).profile;
  const none = resolveCalendarAwareness({
    structureProfiles: [noneProfile], structureProfileId: noneProfile.id, sdcCalendarSource: 'gouhua',
  }, { chatMetadata: {} });
  assert.equal(none.ok, true);
  assert.equal(none.required, false);
  assert.ok(!none.message.includes('不可用'));
});

test('calendar and chat-change watcher reacts to gouhua event and cleans up without toast spam', () => {
  class FakeEventSource {
    constructor() { this.listeners = new Map(); }
    on(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
    removeListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== fn)); }
    emit(name) { for (const fn of this.listeners.get(name) || []) fn(); }
  }
  const windowObject = new EventTarget();
  const eventSource = new FakeEventSource();
  let calls = 0;
  const stop = watchCalendarAwareness({
    eventSource,
    eventTypes: { CHAT_CHANGED: 'chat_changed' },
    windowObject,
    onChanged: () => { calls++; },
  });
  windowObject.dispatchEvent(new Event(GOUHUA_CALENDAR_CHANGED_EVENT));
  eventSource.emit('chat_changed');
  assert.equal(calls, 2);
  stop();
  windowObject.dispatchEvent(new Event(GOUHUA_CALENDAR_CHANGED_EVENT));
  eventSource.emit('chat_changed');
  assert.equal(calls, 2);
});

// ===== Quick Reply command / installer =====

function makeApi({ enabled = true, existingSets = [] } = {}) {
  const sets = new Map();
  const createCalls = [];
  for (const entry of existingSets) {
    const set = { name: entry.name, qrs: entry.qrs || [], saves: 0, async save() { this.saves++; } };
    sets.set(entry.name, set);
  }
  const globalSets = [];
  const api = {
    settings: { isEnabled: enabled },
    listSets: () => [...sets.keys()],
    getSetByName: name => sets.get(name),
    listQuickReplies: name => (sets.get(name)?.qrs || []).map(qr => qr.label),
    getQrByLabel: (name, label) => (sets.get(name)?.qrs || []).find(qr => Number.isInteger(label) ? qr.id === label : qr.label === label),
    listGlobalSets: () => [...globalSets],
    addGlobalSet: (name, visible = true) => {
      if (!sets.has(name)) throw new Error('missing set');
      if (!globalSets.includes(name)) globalSets.push(name);
      assert.equal(visible, true);
    },
    createSet: async (name, props) => {
      createCalls.push({ name, props });
      if (sets.has(name)) throw new Error(`refusing to replace existing set ${name}`);
      const set = { name, qrs: [], saves: 0, async save() { this.saves++; } };
      sets.set(name, set);
      return set;
    },
    createQuickReply: (name, label, props) => {
      const set = sets.get(name);
      if (!set) throw new Error('missing set');
      const qr = { id: set.qrs.length + 1, label, ...props };
      set.qrs.push(qr);
      return qr;
    },
  };
  return { api, sets, globalSets, createCalls };
}

test('quick reply slash command registers once, refuses a collision, returns empty and never sends chat text', async () => {
  const commands = {};
  let runs = 0;
  const parser = {
    commands,
    addCommandObject(command) { commands[command.name] = command; },
  };
  const commandClass = { fromProps: props => props };
  const ctx = { SlashCommandParser: parser, SlashCommand: commandClass };
  const first = registerQuickReplyCommand({
    ctx,
    runRepair: async () => { runs++; return { success: true }; },
  });
  assert.equal(first.ok, true);
  const callbackResult = await commands[RESPONSE_LINTER_COMMAND_NAME].callback({}, '');
  assert.equal(callbackResult, '');
  assert.equal(runs, 1);
  const second = registerQuickReplyCommand({ ctx, runRepair: async () => { runs++; } });
  assert.equal(second.state, 'reused');
  assert.equal(runs, 1);

  const collisionCommands = { [RESPONSE_LINTER_COMMAND_NAME]: { unrelated: true } };
  const collision = registerQuickReplyCommand({
    ctx: { SlashCommandParser: { commands: collisionCommands, addCommandObject() {} }, SlashCommand: commandClass },
    runRepair: async () => {},
  });
  assert.equal(collision.ok, false);
  assert.equal(collision.state, 'collision');
  assert.equal(collisionCommands[RESPONSE_LINTER_COMMAND_NAME].unrelated, true);
});

test('quick reply installs one own unique set, is idempotent across reloads and never overwrites an unrelated same-name set', async () => {
  const existing = { name: 'Response Linter', qrs: [{ id: 1, label: '用户按钮', title: 'user', message: '/echo keep' }] };
  const fake = makeApi({ existingSets: [existing] });
  let state = defaultQuickReplyInstallState();
  const installer = createQuickReplyInstaller({
    getApi: () => fake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const first = await installer.ensureInstalled();
  assert.equal(first.state, 'installed');
  assert.equal(first.setName, 'Response Linter (2)');
  assert.equal(fake.sets.get('Response Linter').qrs[0].message, '/echo keep');
  assert.equal(fake.sets.get(first.setName).qrs.length, 1);
  assert.deepEqual(fake.globalSets, [first.setName]);
  const ownQr = fake.sets.get(first.setName).qrs[0];
  assert.equal(ownQr.message, `/${RESPONSE_LINTER_COMMAND_NAME}`);
  assert.ok(ownQr.title.includes(QUICK_REPLY_ITEM_TITLE_MARKER));
  assert.equal(ownQr.executeOnStartup, false);
  assert.equal(ownQr.executeOnAi, false);
  assert.equal(ownQr.executeOnUser, false);

  const reloadInstaller = createQuickReplyInstaller({
    getApi: () => fake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const reloaded = await reloadInstaller.ensureInstalled();
  assert.equal(reloaded.state, 'installed');
  assert.equal(fake.createCalls.length, 1);
  assert.equal(fake.sets.get(reloaded.setName).qrs.length, 1);
  assert.deepEqual(fake.globalSets, [reloaded.setName]);
});

test('quick reply respects disabled/unavailable APIs and does not re-add a removed button after completion', async () => {
  const disabledFake = makeApi({ enabled: false });
  let state = defaultQuickReplyInstallState();
  const disabledInstaller = createQuickReplyInstaller({
    getApi: () => disabledFake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const disabled = await disabledInstaller.ensureInstalled();
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabledFake.createCalls.length, 0);

  const unavailableInstaller = createQuickReplyInstaller({
    getApi: () => null,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  assert.equal((await unavailableInstaller.ensureInstalled()).state, 'unavailable');

  const fake = makeApi();
  state = defaultQuickReplyInstallState();
  const installer = createQuickReplyInstaller({
    getApi: () => fake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const installed = await installer.ensureInstalled();
  const set = fake.sets.get(installed.setName);
  set.qrs = [];
  const removed = await installer.ensureInstalled();
  assert.equal(removed.state, 'removed');
  assert.equal(set.qrs.length, 0);
  assert.equal(fake.createCalls.length, 1);

  const restored = await installer.restore();
  assert.equal(restored.state, 'installed');
  assert.equal(fake.sets.get(restored.setName).qrs.length, 1);
  assert.equal(fake.createCalls.length, 1, 'restore reused the persisted own set instead of creating another');
});

test('quick reply skips on slash-command collision, auto-activates only once and respects user-edited hidden buttons', async () => {
  const fake = makeApi();
  let state = defaultQuickReplyInstallState();
  const collisionInstaller = createQuickReplyInstaller({
    getApi: () => fake.api,
    getCommandReady: () => ({ ok: false, state: 'collision', reason: 'command taken' }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const collision = await collisionInstaller.ensureInstalled();
  assert.equal(collision.state, 'collision');
  assert.equal(fake.createCalls.length, 0);

  const installer = createQuickReplyInstaller({
    getApi: () => fake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const installed = await installer.ensureInstalled();
  const set = fake.sets.get(installed.setName);
  set.qrs[0].isHidden = true;
  set.qrs[0].title = '用户改过的标题';
  state.activated = true;
  fake.globalSets.length = 0;
  const afterUserEdit = await installer.ensureInstalled();
  assert.equal(afterUserEdit.state, 'installed');
  assert.equal(set.qrs[0].isHidden, true);
  assert.equal(set.qrs[0].title, '用户改过的标题');
  assert.deepEqual(fake.globalSets, [], 'does not re-activate a set the user removed');
});

test('late Quick Reply API readiness uses bounded retries and stops after a completed install', async () => {
  const fake = makeApi();
  let api = null;
  let state = defaultQuickReplyInstallState();
  const installer = createQuickReplyInstaller({
    getApi: () => api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const timers = [];
  const readiness = startQuickReplyReadiness({
    installer,
    maxAttempts: 3,
    retryDelayMs: 0,
    setTimeoutFn: fn => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  await readiness.wait();
  assert.equal(readiness.getAttempts() >= 0, true);
  api = fake.api;
  assert.equal(timers.length >= 1, true);
  timers.shift()();
  await readiness.wait();
  assert.equal(readiness.isStopped(), true);
  assert.equal(fake.createCalls.length, 1);
  assert.deepEqual(fake.globalSets, ['Response Linter']);
});

// ===== metadata preservation with realistic memory anchors =====

function memoryExtra(label) {
  return {
    display_text: label,
    qianqianjie_floor: { schemaVersion: 2, floorId: `floor-${label}`, chatId: 'qqj-chat', anchor: { sourceId: 1 } },
    qianqianjieAutoHide: { schemaVersion: 1, chatId: 'qqj-chat', reason: 'auto' },
    qqj_v3_recall_receipt: { schemaVersion: 1, fingerprint: `fp-${label}` },
    qianqianjie_memory_excluded: true,
    keep_me: { nested: [1, 2, 3] },
  };
}

test('repair, undo and save rollback preserve memory extra keys, swipe_info, inactive swipes and chat metadata', async () => {
  const profile = customTimeProfile();
  const source = '<正文>\n【开始：1年冬28日·周日·23:50】\n正文\n【水印】logo\n</正文>\n<选项>opt</选项>\n<内心独白>mono</内心独白>';
  const inactive = '<正文>另一个未激活候选</正文>';
  const message = {
    name: 'AI',
    is_user: false,
    swipe_id: 0,
    mes: source,
    swipes: [source, inactive],
    swipe_info: [
      { extra: memoryExtra('active') },
      { extra: memoryExtra('inactive') },
    ],
    extra: memoryExtra('message'),
  };
  message.extra.display_text = source;
  message.swipe_info[0].extra.display_text = source;
  message.swipe_info[1].extra.display_text = inactive;
  __testContext.chat = [message];
  __testContext.chatMetadata = {
    qianqianjie: { schemaVersion: 2, chatId: 'qqj-chat', file: { characterLocator: 'c', hostChatId: 'h' } },
    qianqianjiePrequel: 'stable prequel',
    'sp-store': { data: { 'caldesc-user': { kind: 'custom', weekdayCycle: 7, months: [{ name: '春', days: 28 }] } } },
    other: { nested: true },
  };
  const metadataSnapshot = structuredClone(__testContext.chatMetadata);
  const extraBefore = structuredClone(message.extra);
  const swipeInfoBefore = structuredClone(message.swipe_info);

  controller.updateSettings({
    enabled: true,
    autoFix: false,
    defaultAutoFixAction: 'apply',
    rules: [],
    structureProfilesVersion: 1,
    structureProfiles: [profile],
    structureProfileId: profile.id,
    repairSdcBoundary: true,
    repairDetailsOrder: true,
    sdcCalendarSource: 'four-seasons-28',
    sdcAdvanceMinutes: 10,
  });
  const repaired = await controller.triggerManualFix('0');
  assert.equal(repaired.success, true);
  assert.ok(message.mes.includes('【结束：2年春1日·周一·00:00】'));
  assert.ok(message.content === undefined);
  assert.ok(message.mes.indexOf('<内心独白>') < message.mes.indexOf('<选项>'));
  assert.equal(message.extra.display_text, message.mes);
  assert.equal(message.swipes[0], message.mes);
  assert.equal(message.swipes[1], inactive, 'inactive swipe bytes unchanged');
  assert.deepEqual(message.swipe_info, swipeInfoBefore, 'swipe_info extras unchanged');
  assert.deepEqual(__testContext.chatMetadata, metadataSnapshot, 'chat metadata untouched');
  assert.deepEqual({ ...message.extra, display_text: extraBefore.display_text }, extraBefore);
  assert.equal(message.extra.qianqianjie_floor.floorId, 'floor-message');
  assert.equal(saves, 1);
  assert.equal(__testContext.eventSource.emitted, 0, 'no fake MESSAGE_EDITED/host events emitted');

  const undo = await controller.undoFix('0');
  assert.equal(undo.success, true);
  assert.equal(message.mes, source);
  assert.equal(message.extra.display_text, source);
  assert.equal(message.swipes[0], source);
  assert.equal(message.swipes[1], inactive);
  assert.deepEqual(message.swipe_info, swipeInfoBefore);
  assert.deepEqual(__testContext.chatMetadata, metadataSnapshot);
  assert.equal(__testContext.eventSource.emitted, 0);

  // Rollback on save failure must restore all content fields and metadata.
  __testContext.saveChat = async () => { throw new Error('save failed'); };
  const beforeRollback = structuredClone(message);
  const failed = await controller.triggerManualFix('0');
  assert.equal(failed.success, false);
  assert.equal(message.mes, beforeRollback.mes);
  assert.equal(message.extra.display_text, beforeRollback.extra.display_text);
  assert.equal(message.swipes[0], beforeRollback.swipes[0]);
  assert.equal(message.swipes[1], inactive);
  assert.deepEqual(message.swipe_info, swipeInfoBefore);
  assert.deepEqual(__testContext.chatMetadata, metadataSnapshot);
  assert.equal(saves, 2, 'repair + undo saves; failed rollback does not count another successful save');
});

test('ordinary rule planning still uses the profile path and preserves current settings shape', () => {
  const profile = plainProfile({ blocks: [] });
  const rule = { id: 'r', name: '正文', enabled: true, requiredContent: ['【正文】', '【/正文】'], fixStrategy: 'add-missing-tags' };
  const settings = {
    structureProfilesVersion: 1,
    structureProfiles: [profile],
    structureProfileId: profile.id,
    repairSdcBoundary: true,
    repairDetailsOrder: false,
  };
  assert.deepEqual(Object.keys(normalizeRepairSettings(settings)).sort(), [
    'advanceMinutes', 'calendarSource', 'customCalendarJson', 'detailsChoicesKeyword',
    'detailsMonologueKeyword', 'raw', 'removeLeakedReasoning', 'repairDetailsOrder', 'repairSdcBoundary',
  ].sort());
  const source = '【正文】正文';
  const result = transformContent(source, settings, { chatMetadata: {} });
  assert.equal(result.changed, false);
  assert.equal(rule.requiredContent.length, 2);
});

test('literal profile delimiters are case-exact while HTML tags remain case-insensitive', () => {
  const literalProfile = plainProfile({ auxiliaries: ['TAIL:'], blocks: [] });
  const raw = 'body:正文 TAIL:尾部 :body';
  const result = repairProfileBodyBoundary(raw, literalProfile, {});
  assert.equal(result.changed, false);
  assert.equal(result.content, raw);
  assert.equal(repairProfileBodyBoundary('【正文】正文【/正文】', literalProfile, {}).changed, false);
});

test('custom time template literals are case-exact during repair', () => {
  const profile = validateStructureProfile({
    version: STRUCTURE_PROFILES_VERSION,
    id: 'case-exact-time',
    name: '大小写精确时间',
    body: { open: '<content>', close: '</content>' },
    time: {
      mode: 'custom',
      startTemplate: '[BEGIN {date}|{weekday}|{time}]',
      endTemplate: '[END {date}|{weekday}|{time}]',
    },
    blocks: [{ id: 'tail', label: '外部', open: '<aside>', close: '</aside>' }],
  }).profile;
  const raw = '<content>[begin 1年夏5日|周五|12:20]正文<aside>外部</aside>[end 1年夏5日|周五|12:30]</content>';
  const result = repairProfileBodyBoundary(raw, profile, {});
  assert.equal(result.changed, false);
  assert.equal(result.content, raw);
});

test('correct custom time/body pair keeps unknown external tail instead of extending the body', () => {
  const profile = customTimeProfile({ auxiliaries: [], blocks: [] });
  const raw = '<正文>[开始：1年夏5日·周五·12:20]正文[结束：1年夏5日·周五·12:30]</正文><unknown>外部内容</unknown>';
  const result = repairProfileBodyBoundary(raw, profile, { calendar: FOUR_SEASONS_28 });
  assert.equal(result.changed, false);
  assert.equal(result.content, raw);
  assert.ok(result.content.endsWith('<unknown>外部内容</unknown>'));
});

test('strict profile validation rejects mismatched HTML pairs, oversized ids and delimiter conflicts', () => {
  assert.equal(validateStructureProfile({
    ...createBlankProfile(), body: { open: '<story>', close: '</other>' },
  }).ok, false);
  assert.equal(validateStructureProfile({
    ...createBlankProfile(), id: 'x'.repeat(81),
  }).ok, false);
  assert.equal(validateStructureProfile({
    ...createBlankProfile(),
    blocks: [{ id: 'b', label: 'b', open: '<choice>', close: '</other>' }],
  }).ok, false);
  assert.equal(validateStructureProfile({
    ...createBlankProfile(), name: '无结构块但有效', blocks: [],
  }).ok, true);
});

test('import/export ceilings agree for maximum profile/block counts and old keyword fields stay live', () => {
  const profiles = [];
  for (let index = 0; index < 40; index++) {
    const blocks = [];
    for (let block = 0; block < 20; block++) {
      const tag = `X${index}_${block}`;
      blocks.push({
        id: `b${index}_${block}`,
        label: `L${index}_${block}`.padEnd(60, 'x'),
        open: `OPEN${tag}`.padEnd(240, 'o'),
        close: `CLOSE${tag}`.padEnd(240, 'c'),
      });
    }
    profiles.push({
      version: 1,
      id: `p${index}`,
      name: `Profile${index}`.padEnd(60, 'p'),
      body: { open: `BEGIN${index}`.padEnd(240, 'b'), close: `END${index}`.padEnd(240, 'e') },
      time: { mode: 'none' },
      auxiliaries: [],
      blocks,
    });
  }
  const exported = createStructureSettingsExport({
    structureProfiles: profiles, structureProfileId: 'p39',
    detailsMonologueKeyword: 'm', detailsChoicesKeyword: 'c',
    sdcCalendarSource: 'four-seasons-28', sdcAdvanceMinutes: 10,
  });
  const text = JSON.stringify(exported, null, 2);
  assert.ok(text.length > 50000, 'supported maximum export exceeds the old 50k ceiling');
  const imported = importStructureSettingsText(text, { structureProfiles: profiles, structureProfileId: 'p39' });
  assert.equal(imported.ok, true);
  assert.equal(imported.settings.structureProfiles.length, 40);
  assert.equal(imported.settings.structureProfiles[39].blocks.length, 20);

  const previous = { structureProfiles: [createLegacyProfile({ detailsMonologueKeyword: 'oldM', detailsChoicesKeyword: 'oldC' })], structureProfileId: LEGACY_PROFILE_ID };
  const oldStyle = {
    format: 'response-linter-structure-settings', version: 1,
    detailsMonologueKeyword: '新独白', detailsChoicesKeyword: '新选择',
    sdcCalendarSource: 'four-seasons-28', sdcAdvanceMinutes: 10,
  };
  const importedOld = importStructureSettingsText(JSON.stringify(oldStyle), previous);
  assert.equal(importedOld.ok, true);
  const runtime = readStructureProfiles(importedOld.settings);
  assert.deepEqual(runtime.activeProfile.blocks.map(block => block.titleKeyword), ['新独白', '新选择']);
});

test('bundled Quick Reply descriptor file matches the runtime descriptor', () => {
  const file = JSON.parse(readFileSync(new URL('../presentation/quick-reply/response-linter-fix.qr.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, quickReplyDescriptor());
  assert.equal(file.command.name, RESPONSE_LINTER_COMMAND_NAME);
});

test('explicit Quick Reply restore reactivates a completed set and reports activation failures for retry', async () => {
  const fake = makeApi();
  let state = defaultQuickReplyInstallState();
  const installer = createQuickReplyInstaller({
    getApi: () => fake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const installed = await installer.ensureInstalled();
  assert.equal(installed.state, 'installed');
  state.activated = true;
  fake.globalSets.length = 0;
  const restored = await installer.restore();
  assert.equal(restored.state, 'installed');
  assert.deepEqual(fake.globalSets, [restored.setName]);
  assert.equal(state.activated, true);

  let failActivation = true;
  const failingFake = makeApi();
  failingFake.api.addGlobalSet = () => { throw new Error('activation unavailable'); };
  let failingState = defaultQuickReplyInstallState();
  const failingInstaller = createQuickReplyInstaller({
    getApi: () => failingFake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => failingState,
    writeState: next => { failingState = next; },
  });
  const failed = await failingInstaller.ensureInstalled();
  assert.equal(failed.state, 'error');
  assert.match(failed.message, /激活/);
  assert.equal(failingState.activated, false);
  assert.equal(failingFake.sets.get(failed.setName).qrs.length, 1);
  // Retry after the host recovers.
  failingFake.api.addGlobalSet = (name, visible) => {
    if (!failingFake.globalSets.includes(name)) failingFake.globalSets.push(name);
  };
  assert.equal((await failingInstaller.ensureInstalled()).state, 'installed');
  assert.equal(failingState.activated, true);

  // Save failure must not be reported as installed and must not duplicate the button.
  const saveFake = makeApi();
  const createdSet = {
    name: 'Response Linter', qrs: [], saves: 0,
    async save() { this.saves++; if (this.saves === 1) throw new Error('save unavailable'); },
  };
  saveFake.sets.set(createdSet.name, createdSet);
  saveFake.api.getSetByName = name => saveFake.sets.get(name);
  let saveState = { ...defaultQuickReplyInstallState(), setName: createdSet.name };
  const saveInstaller = createQuickReplyInstaller({
    getApi: () => saveFake.api,
    getCommandReady: () => ({ ok: true }),
    readState: () => saveState,
    writeState: next => { saveState = next; },
  });
  const saveFailed = await saveInstaller.ensureInstalled();
  assert.equal(saveFailed.state, 'error');
  assert.match(saveFailed.message, /保存/);
  assert.equal(saveState.completed, false);
  const saveRecovered = await saveInstaller.ensureInstalled();
  assert.equal(saveRecovered.state, 'installed');
  assert.equal(createdSet.qrs.length, 1);
});

test('APP_READY can still retry after bounded Quick Reply timers stop', async () => {
  const fake = makeApi();
  let api = null;
  let state = defaultQuickReplyInstallState();
  const installer = createQuickReplyInstaller({
    getApi: () => api,
    getCommandReady: () => ({ ok: true }),
    readState: () => state,
    writeState: next => { state = next; },
  });
  const listeners = new Map();
  const eventSource = {
    on(name, fn) { listeners.set(name, fn); },
    removeListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    emit(name) { listeners.get(name)?.(); },
  };
  const timers = [];
  const readiness = startQuickReplyReadiness({
    installer, eventSource, eventTypes: { APP_READY: 'app_ready' },
    maxAttempts: 2, retryDelayMs: 0,
    setTimeoutFn: fn => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  await readiness.wait();
  while (timers.length) {
    const next = timers.shift();
    next();
    await readiness.wait();
  }
  assert.equal(readiness.isStopped(), true, 'bounded timer window stopped');
  api = fake.api;
  eventSource.emit('app_ready');
  await readiness.wait();
  assert.equal(fake.createCalls.length, 1, 'later APP_READY still installs');
  assert.equal(listeners.has('app_ready'), true, 'ready listener remains until explicit stop');
  readiness.stop();
  assert.equal(listeners.has('app_ready'), false);
});

test('undo keeps QQJ metadata inserted after repair instead of restoring a stale text-only snapshot', async () => {
  const profile = plainProfile({ blocks: [] });
  const source = '【正文】正文\n【水印】logo\n【/正文】';
  const message = messageFixture(source, {
    extra: {
      qianqianjie_floor: { schemaVersion: 1, chatId: 'qqj-chat', floorId: 'floor-a' },
      keep: 1,
    },
  });
  message.swipe_info = [{ extra: { qianqianjie_floor: { schemaVersion: 1, chatId: 'qqj-chat', floorId: 'floor-a' } } }];
  __testContext.chat = [message];
  __testContext.chatMetadata = { qianqianjie: { schemaVersion: 2, chatId: 'qqj-chat' } };
  const metadataBefore = structuredClone(__testContext.chatMetadata);
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: [],
    structureProfilesVersion: 1, structureProfiles: [profile], structureProfileId: profile.id,
    repairSdcBoundary: true,
  });
  assert.equal((await controller.triggerManualFix('0')).success, true);
  // Simulate QQJ writing new ownership/memory fields between apply and undo.
  message.extra.qqj_v3_recall_receipt = { id: 'new-receipt' };
  message.extra.qianqianjie_memory_excluded = true;
  message.swipe_info[0].extra.qqj_v3_recall_receipt = { id: 'new-swipe-receipt' };
  __testContext.chatMetadata.qianqianjie.latestRevision = 3;
  const expectedExtra = structuredClone(message.extra);
  delete expectedExtra.display_text;
  const expectedSwipeInfo = structuredClone(message.swipe_info);
  const expectedMeta = structuredClone(__testContext.chatMetadata);
  assert.equal((await controller.undoFix('0')).success, true);
  assert.equal(message.mes, source);
  assert.equal(message.extra.display_text, source);
  const actualExtra = { ...message.extra };
  delete actualExtra.display_text;
  assert.deepEqual(actualExtra, expectedExtra);
  assert.deepEqual(message.swipe_info, expectedSwipeInfo);
  assert.deepEqual(__testContext.chatMetadata, expectedMeta);
  assert.deepEqual(__testContext.chatMetadata, expectedMeta);
  assert.ok(message.extra.qianqianjie_floor.floorId === 'floor-a');
  assert.ok(!('qqj_v3_recall_receipt' in { ...expectedMeta }));
});
