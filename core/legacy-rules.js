// One-time, inert archive for the 1.4.9-and-earlier generic validation rules.
// Nothing in this module executes rules. The archive is data only and is
// intentionally never rewritten once present.
export const LEGACY_RULES_BACKUP_KEY = 'legacyRulesBackup';
export const LEGACY_RULES_BACKUP_FORMAT = 'response-linter-legacy-rules';
export const LEGACY_RULES_BACKUP_VERSION = 1;
export const MAX_LEGACY_RULES_BACKUP_TEXT = 2_000_000;

function cloneJson(value) {
  if (value == null) return value;
  try { return structuredClone(value); } catch {}
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasForbiddenKey(value, depth = 0, seen = new WeakSet()) {
  if (depth > 16 || value == null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
    if (hasForbiddenKey(value[key], depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Build an inert backup. The rules array is preserved as data, including
 * disabled items, unknown fields and custom strategy descriptions. Rule
 * executors are never imported or invoked from this module.
 */
export function createLegacyRulesBackup(rules, { archivedAt = new Date().toISOString(), note = '' } = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  return {
    format: LEGACY_RULES_BACKUP_FORMAT,
    version: LEGACY_RULES_BACKUP_VERSION,
    archivedAt,
    note: note || 'Generic validation rules are archived for reference only. They are not executed.',
    count: rules.length,
    rules: cloneJson(rules),
  };
}

export function validateLegacyRulesBackup(value) {
  if (!isPlainObject(value)) return { ok: false, error: '旧版规则备份必须是对象' };
  if (hasForbiddenKey(value)) return { ok: false, error: '旧版规则备份包含不允许的属性名' };
  if (value.format != null && value.format !== LEGACY_RULES_BACKUP_FORMAT) {
    return { ok: false, error: '未知的旧版规则备份格式' };
  }
  if (value.version != null && value.version !== LEGACY_RULES_BACKUP_VERSION) {
    return { ok: false, error: '不支持的旧版规则备份版本' };
  }
  if (!Array.isArray(value.rules)) return { ok: false, error: '旧版规则备份缺少 rules 数组' };
  let text = '';
  try { text = JSON.stringify(value); } catch { return { ok: false, error: '旧版规则备份无法序列化' }; }
  if (text.length > MAX_LEGACY_RULES_BACKUP_TEXT) return { ok: false, error: '旧版规则备份过长' };
  return { ok: true, backup: value };
}

export function readLegacyRulesBackup(settings = {}) {
  const value = isPlainObject(settings) ? settings[LEGACY_RULES_BACKUP_KEY] : null;
  const checked = validateLegacyRulesBackup(value);
  return checked.ok ? checked.backup : null;
}

/**
 * Archive the current active generic rules exactly once. If any backup object
 * is already present it is left untouched, even if it is malformed; subsequent
 * loads must not replace the user's original archived data.
 *
 * @returns {{fields:Object, archived:boolean, count:number, existing:boolean}}
 */
export function archiveLegacyRules(settings = {}, { archivedAt = new Date().toISOString() } = {}) {
  const raw = isPlainObject(settings) ? settings : {};
  const existing = raw[LEGACY_RULES_BACKUP_KEY];
  if (existing != null) return { fields: {}, archived: false, count: 0, existing: true };
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    return { fields: {}, archived: false, count: 0, existing: false };
  }
  const backup = createLegacyRulesBackup(raw.rules, { archivedAt });
  return {
    fields: { [LEGACY_RULES_BACKUP_KEY]: backup },
    archived: true,
    count: backup.count,
    existing: false,
  };
}

/**
 * Remove the active legacy rules after archiving. The backup remains the only
 * copy in settings and no production path reads it as executable state.
 */
export function stripActiveLegacyRules(settings = {}) {
  if (!isPlainObject(settings)) return false;
  if (!Object.prototype.hasOwnProperty.call(settings, 'rules')) return false;
  delete settings.rules;
  return true;
}

/**
 * A standalone, clearly labelled download payload for the inert archive.
 */
export function createLegacyRulesBackupExport(settings = {}) {
  const backup = readLegacyRulesBackup(settings);
  if (!backup) throw new Error('没有可导出的旧版规则备份');
  return {
    format: LEGACY_RULES_BACKUP_FORMAT,
    version: LEGACY_RULES_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    note: '仅作迁移留档；响应检查器 1.4.10 不会执行这些规则。',
    backup,
  };
}

/**
 * Imported archive data is data-only. The previous local archive always wins so
 * a config import can never silently replace the original verbatim backup.
 */
export function mergeLegacyRulesBackup(previousSettings = {}, importedBackup = null) {
  const existing = readLegacyRulesBackup(previousSettings);
  if (existing) return { backup: existing, preserved: true };
  if (importedBackup == null) return { backup: null, preserved: false };
  const checked = validateLegacyRulesBackup(importedBackup);
  if (!checked.ok) return { backup: null, preserved: false, error: checked.error };
  return { backup: checked.backup, preserved: false };
}
