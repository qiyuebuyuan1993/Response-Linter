// Run: node --test tests/*.mjs (Node.js 24) or node tests/features-1.4.10.mjs
// 1.4.10 streamlined edition: one-way profile migration, inert legacy-rule
// archive, backward-compatible imports, and rule-free manual/auto repair.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const {
  LEGACY_PROFILE_ID,
  STRUCTURE_PROFILES_MIGRATION_KEY,
  createLegacyProfile,
  migrateStructureProfileSettings,
  validateStructureProfile,
} = await import('../core/structure-profiles.js');
const {
  LEGACY_RULES_BACKUP_KEY,
  archiveLegacyRules,
  createLegacyRulesBackupExport,
  readLegacyRulesBackup,
  stripActiveLegacyRules,
} = await import('../core/legacy-rules.js');
const {
  createStructureSettingsExport,
  importStructureSettingsText,
} = await import('../core/settings-transfer.js');
const { normalizeRepairSettings } = await import('../core/repair-service.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { messageModifier } = await import('../core/message-modifier.js');
const { createBackendController } = await import('../core/backend-controller.js');

const controller = createBackendController('response-linter');
controller.start = () => { controller.isRunning = true; };
controller.stop = () => { controller.isRunning = false; };
fixCoordinator._sleep = async () => {};

const boundaryProfile = validateStructureProfile({
  id: 'streamlined-boundary',
  name: '精简正文结构',
  body: { open: '【正文】', close: '【/正文】' },
  time: { mode: 'none' },
  auxiliaries: ['【水印】'],
  blocks: [],
}).profile;

const customProfile = validateStructureProfile({
  id: 'user-custom',
  name: '用户自定义',
  body: { open: '<正文>', close: '</正文>' },
  time: { mode: 'none' },
  auxiliaries: ['【水印】'],
  blocks: [{ id: 'a', label: 'A', open: '【选项】', close: '【/选项】' }],
}).profile;

function messageFixture(mes, extra = {}) {
  return { mes, is_user: false, swipe_id: 0, swipes: [mes], extra: { display_text: mes, ...extra } };
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

let saves;
beforeEach(() => {
  assert.equal(fixCoordinator.fixQueue.length, 0);
  fixCoordinator.isProcessing = false;
  fixCoordinator._sleep = async () => {};
  messageModifier.modificationHistory.clear();
  messageModifier.pendingModifications.clear();
  messageHandler.lastContent.clear();
  messageHandler.lastHandledAt.clear();
  messageHandler.retryCounts.clear();
  __testContext.chat = [];
  __testContext.extensionSettings = {};
  __testContext.chatMetadata = {};
  __testContext.streamingProcessor = null;
  __testContext.updateMessageBlock = async id => { await messageHandler._handleMessageRendered(String(id)); };
  __testContext.saveChat = async () => { saves++; };
  saves = 0;
  globalThis.UIState = { rules: [] };
  controller.resetStatistics();
});

test('migration is idempotent and preserves flags, selection, custom profile delimiters/order and keywords', () => {
  const old = {
    enabled: true,
    autoFix: true,
    defaultAutoFixAction: 'preview',
    rules: [{ id: 'old', enabled: true, requiredContent: ['<content>'] }],
    removeLeakedReasoning: true,
    repairSdcBoundary: true,
    repairDetailsOrder: true,
    detailsMonologueKeyword: '心声',
    detailsChoicesKeyword: '抉择',
    sdcCalendarSource: 'four-seasons-28',
    sdcAdvanceMinutes: 15,
    structureProfilesVersion: 1,
    structureProfiles: [createLegacyProfile({ detailsMonologueKeyword: '心声', detailsChoicesKeyword: '抉择' }), customProfile],
    structureProfileId: customProfile.id,
    untouched: 'keep',
  };
  const before = structuredClone(old);
  const first = migrateStructureProfileSettings(old);
  assert.equal(first.migrated, true);
  assert.equal(first.fields.structureProfileId, customProfile.id, 'user selected custom profile is not reset');
  assert.equal(first.fields[STRUCTURE_PROFILES_MIGRATION_KEY], 1);
  assert.deepEqual(first.fields.structureProfiles[1], customProfile, 'custom delimiters/order are untouched');
  const legacy = first.fields.structureProfiles[0];
  assert.equal(legacy.builtin, false);
  assert.deepEqual(legacy.blocks.map(block => block.id), ['monologue', 'choices']);
  assert.deepEqual(legacy.blocks.map(block => block.titleKeyword), ['心声', '抉择']);
  assert.equal(old.repairSdcBoundary, true);
  assert.equal(old.untouched, 'keep');
  assert.deepEqual(old.structureProfiles, before.structureProfiles);

  Object.assign(old, first.fields);
  const second = migrateStructureProfileSettings(old);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.fields, {});
  assert.deepEqual(old.structureProfiles, first.fields.structureProfiles, 'second load never rewrites the editable profile');
});

test('legacy keywords are copied into the editable profile and no separate runtime keyword editors remain', () => {
  const old = {
    detailsMonologueKeyword: '心底话',
    detailsChoicesKeyword: '怎么选',
    structureProfiles: [createLegacyProfile({})],
    structureProfileId: LEGACY_PROFILE_ID,
  };
  const migrated = migrateStructureProfileSettings(old);
  const profile = migrated.fields.structureProfiles[0];
  assert.equal(profile.id, LEGACY_PROFILE_ID);
  assert.equal(profile.builtin, false);
  assert.deepEqual(profile.blocks.map(block => block.titleKeyword), ['心底话', '怎么选']);
  const normalized = normalizeRepairSettings({ ...old, ...migrated.fields });
  assert.equal(Object.hasOwn(normalized, 'detailsMonologueKeyword'), false);
  assert.equal(Object.hasOwn(normalized, 'detailsChoicesKeyword'), false);

  const html = readFileSync(new URL('../presentation/templates/settings.html', import.meta.url), 'utf8');
  assert.equal(html.includes('rl-details-monologue-keyword'), false);
  assert.equal(html.includes('rl-details-choices-keyword'), false);
  assert.equal((html.match(/rl-repair-plan-section/g) || []).length, 1);
  assert.equal((html.match(/id="rl-profile-editor"/g) || []).length, 1);
  assert.equal(html.includes('rl-structure-section'), false);
  assert.equal(html.includes('回复结构清理'), false);
  assert.equal(html.includes('配置向导'), false);
  assert.equal(html.includes('统计信息'), false);
  assert.equal(html.includes('rl-add-rule'), false);
  assert.equal(html.includes('rl-config-wizard'), false);
});

test('legacy rules archive once, keep verbatim data, and are never overwritten on later loads', () => {
  const originalRules = [
    { id: 'a', name: '旧规则 A', enabled: true, requiredContent: ['<content>'], customStrategy: { pattern: 'x', replacement: 'y' } },
    { id: 'b', name: '旧规则 B', enabled: false, requiredContent: [] },
  ];
  const settings = { rules: structuredClone(originalRules), removeLeakedReasoning: true };
  const first = archiveLegacyRules(settings, { archivedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.archived, true);
  assert.equal(first.count, 2);
  Object.assign(settings, first.fields);
  const backup = readLegacyRulesBackup(settings);
  assert.equal(backup.format, 'response-linter-legacy-rules');
  assert.equal(backup.archivedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(JSON.stringify(backup.rules), JSON.stringify(originalRules));
  assert.equal(backup.note.includes('not executed') || backup.note.includes('不可执行') || backup.note.includes('not execute'), true);

  // Mutating the old source array must not mutate the archived verbatim data.
  settings.rules[0].name = '被后续修改';
  assert.deepEqual(readLegacyRulesBackup(settings).rules, originalRules);

  const second = archiveLegacyRules({ ...settings, rules: [{ id: 'new', enabled: true }] });
  assert.equal(second.archived, false);
  assert.equal(second.existing, true);
  assert.deepEqual(second.fields, {});
  assert.deepEqual(readLegacyRulesBackup(settings).rules, originalRules);

  const exported = createLegacyRulesBackupExport(settings);
  assert.equal(exported.backup.archivedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(exported.backup.rules, originalRules);
  assert.equal(stripActiveLegacyRules(settings), true);
  assert.equal(Object.hasOwn(settings, 'rules'), false);
});

test('old imports with rules stay inert, preserve the existing backup and never return an active rules array', () => {
  const previousBackup = archiveLegacyRules({
    rules: [{ id: 'local', name: '本地旧规则', enabled: true }],
  }, { archivedAt: '2026-02-02T00:00:00.000Z' }).fields[LEGACY_RULES_BACKUP_KEY];
  const previous = {
    [LEGACY_RULES_BACKUP_KEY]: previousBackup,
    structureProfiles: [customProfile],
    structureProfileId: customProfile.id,
    removeLeakedReasoning: false,
  };
  const imported = importStructureSettingsText(JSON.stringify({
    format: 'response-linter-structure-settings',
    version: 1,
    removeLeakedReasoning: true,
    repairSdcBoundary: false,
    repairDetailsOrder: false,
    sdcCalendarSource: 'four-seasons-28',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 10,
    rules: [{ id: 'incoming', name: '导入旧规则', enabled: true, fixStrategy: 'add-missing-tags' }],
  }), previous);
  assert.equal(imported.ok, true);
  assert.equal(Object.hasOwn(imported.settings, 'rules'), false);
  assert.equal(imported.settings.removeLeakedReasoning, true);
  assert.deepEqual(imported.settings[LEGACY_RULES_BACKUP_KEY], previousBackup, 'local archive wins during import');

  const cleanImport = importStructureSettingsText(JSON.stringify({
    removeLeakedReasoning: false,
    rules: [{ id: 'incoming-2', enabled: true, requiredContent: ['</content>'] }],
  }), {});
  assert.equal(cleanImport.ok, true);
  assert.equal(Object.hasOwn(cleanImport.settings, 'rules'), false);
  assert.equal(readLegacyRulesBackup(cleanImport.settings).rules[0].id, 'incoming-2');

  const exported = createStructureSettingsExport({
    ...imported.settings,
    structureProfiles: [customProfile],
    structureProfileId: customProfile.id,
  });
  assert.equal(Object.hasOwn(exported, 'rules'), false);
  assert.equal(exported.legacyRulesBackup.rules[0].id, 'local');
});

test('manual and automatic repair ignore an enabled malicious legacy rule while structure features still work', async () => {
  let legacyExecuted = false;
  const maliciousRule = {
    id: 'enabled-evil',
    name: '启用中的旧规则',
    enabled: true,
    requiredContent: ['<content>', '</content>'],
    fixStrategy: 'custom',
    customStrategy: { pattern: '.*', replacement: '<destroyed>' },
    execute: () => { legacyExecuted = true; },
  };

  // Manual path: reasoning cleanup only; no generic rule strategy runs.
  __testContext.chat = [messageFixture('<thinking>泄漏</thinking>\n<content>正文')];
  controller.updateSettings({
    enabled: true,
    autoFix: false,
    defaultAutoFixAction: 'apply',
    rules: [maliciousRule],
    removeLeakedReasoning: true,
    structureProfiles: [customProfile],
    structureProfileId: customProfile.id,
  });
  const manual = await controller.triggerManualFix('0');
  assert.equal(manual.success, true);
  assert.equal(__testContext.chat[0].mes, '<content>正文');
  assert.equal(legacyExecuted, false);
  assert.equal(saves, 1);

  // Automatic path: body/time boundary repair still runs while the rule is inert.
  const source = '【正文】正文\n【水印】logo\n【/正文】';
  __testContext.chat = [messageFixture(source)];
  messageHandler.lastContent.clear();
  controller.updateSettings({
    enabled: true,
    autoFix: true,
    defaultAutoFixAction: 'apply',
    rules: [maliciousRule],
    removeLeakedReasoning: false,
    repairSdcBoundary: true,
    structureProfiles: [boundaryProfile],
    structureProfileId: boundaryProfile.id,
  });
  const applied = waitForEvent('responseLinter.fixApplied');
  await messageHandler._processMessage('0');
  await applied;
  assert.ok(__testContext.chat[0].mes.indexOf('【/正文】') < __testContext.chat[0].mes.indexOf('【水印】'));
  assert.equal(legacyExecuted, false);
  assert.equal(saves, 2);
});

test('no enabled structure feature leaves the message untouched on manual, auto and preview paths', async () => {
  let executed = false;
  const rule = { id: 'evil', enabled: true, requiredContent: ['</content>'], execute: () => { executed = true; } };
  const source = '<content>正文';
  __testContext.chat = [messageFixture(source)];
  const before = structuredClone(__testContext.chat[0]);
  controller.updateSettings({
    enabled: true,
    autoFix: true,
    defaultAutoFixAction: 'apply',
    rules: [rule],
  });
  const manual = await controller.triggerManualFix('0');
  assert.equal(manual.success, false);
  const preview = controller.previewLatestFix();
  assert.equal(preview.success, false);
  await controller._handleMessageProcessed({ messageId: '0', content: source, name: 'AI' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(__testContext.chat[0], before);
  assert.equal(saves, 0);
  assert.equal(executed, false);
  assert.equal(fixCoordinator.fixQueue.length, 0);
});

test('configuration export/import round-trips the archive, profiles and flags without active rules', () => {
  const backup = archiveLegacyRules({
    rules: [{ id: 'legacy-export', enabled: true, name: '导出留档' }],
  }, { archivedAt: '2026-03-03T00:00:00.000Z' }).fields[LEGACY_RULES_BACKUP_KEY];
  const previous = {
    enabled: true,
    autoFix: true,
    defaultAutoFixAction: 'preview',
    removeLeakedReasoning: true,
    repairSdcBoundary: true,
    repairDetailsOrder: false,
    sdcCalendarSource: 'custom',
    sdcCustomCalendarJson: JSON.stringify({
      months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }],
      weekdayCycle: 7,
      dateFormat: '{year}年{month}{day}日',
      advanceMinutes: 25,
    }),
    sdcAdvanceMinutes: 25,
    structureProfiles: [customProfile],
    structureProfileId: customProfile.id,
    [LEGACY_RULES_BACKUP_KEY]: backup,
  };
  const exported = createStructureSettingsExport(previous);
  assert.equal(exported.autoFix, undefined, 'only structure settings are exported');
  assert.equal(exported.removeLeakedReasoning, true);
  assert.equal(exported.legacyRulesBackup.archivedAt, '2026-03-03T00:00:00.000Z');
  assert.equal(Object.hasOwn(exported, 'rules'), false);
  const imported = importStructureSettingsText(JSON.stringify(exported), {});
  assert.equal(imported.ok, true);
  assert.equal(Object.hasOwn(imported.settings, 'rules'), false);
  assert.deepEqual(imported.settings.structureProfiles, exported.structureProfiles);
  assert.equal(imported.settings.sdcCustomCalendarJson, exported.sdcCustomCalendarJson);
  assert.equal(imported.settings.sdcAdvanceMinutes, 25);
  assert.deepEqual(imported.settings.legacyRulesBackup, backup);
});

test('template and launcher expose only the streamlined entrances and controls', () => {
  const html = readFileSync(new URL('../presentation/templates/settings.html', import.meta.url), 'utf8');
  for (const id of [
    'rl-enabled', 'rl-auto-fix', 'rl-default-auto-fix-action', 'rl-manual-fix', 'rl-undo-fix',
    'rl-remove-leaked-reasoning', 'rl-repair-sdc-boundary', 'rl-repair-details-order',
    'rl-profile-select', 'rl-sdc-calendar-source', 'rl-qr-status-text', 'rl-qr-install',
    'rl-legacy-backup-export',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(html.indexOf('<details') < html.indexOf('rl-sdc-calendar-source'), 'calendar lives in a disclosure');
  assert.ok(html.indexOf('高级 / 帮助') < html.indexOf('rl-qr-install'), 'QR restore lives in advanced/help');
  assert.equal(/rl-(add-rule|rules-list|template-thinking|config-wizard|stat-validations)/.test(html), false);
  assert.ok(html.includes('id="rl-diagnostics"'), '1.4.13 adds privacy-safe lifecycle diagnostics without restoring legacy validation');

  const launcher = readFileSync(new URL('../presentation/modules/main-panel-ui.js', import.meta.url), 'utf8');
  assert.ok(launcher.includes('inline-drawer-toggle inline-drawer-header rl-drawer-launcher'));
  assert.ok(launcher.includes('id="rl-open-main-panel"') && launcher.includes('role="button" tabindex="0"'));
  assert.equal(launcher.includes('<button id="rl-open-main-panel"'), false, 'no tiny separate drawer button');
  assert.ok(launcher.includes('extensionsMenuExtensionButton'));
  assert.equal(/<span>响应检查器<\/span>/.test(launcher), true, 'wand row keeps a visible Chinese label');
});
