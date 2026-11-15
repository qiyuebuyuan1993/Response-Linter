// Response Linter 1.4.14 — streamlined structure-repair edition.
// Only the three structure-repair features, editable reply-structure profiles,
// calendar awareness, Quick Reply/wand/drawer entry points and manual/auto
// repair/undo are active. Legacy generic validation rules are archived inertly
// and never loaded into an executor.
import { getFreshContext } from './core/host-context.js';
import {
  DEFAULT_ADVANCE_MINUTES,
  describeCalendar,
} from './core/calendar-engine.js';
import {
  createStructureSettingsExport,
  importStructureSettingsText,
} from './core/settings-transfer.js';
import {
  FEATURE_DEFAULTS,
  mergeFeatureSettings,
  readFeatureSettings,
  seedCustomCalendarDraft,
} from './core/feature-settings.js';
import {
  escapeHtmlText as escapeHtml,
  formatErrorForToast,
  joinWarningToasts,
} from './core/text-safety.js';
import { structureProfileUI } from './presentation/modules/structure-profile-ui.js';
import { openRepairPreview } from './presentation/modules/repair-preview-ui.js';
import { setupDiagnosticsUI } from './presentation/modules/diagnostics-ui.js';
import {
  installDrawerLauncher,
  installWandLauncher,
  setupMainPanel,
} from './presentation/modules/main-panel-ui.js';
import {
  STRUCTURE_PROFILES_MIGRATION_KEY,
  STRUCTURE_PROFILES_MIGRATION_VERSION,
  mergeStructureProfiles,
  migrateStructureProfileSettings,
  readStructureProfiles,
} from './core/structure-profiles.js';
import {
  resolveCalendarAwareness,
  watchCalendarAwareness,
} from './core/calendar-awareness.js';
import { registerQuickReplyCommand } from './core/quick-reply-command.js';
import {
  createQuickReplyInstaller,
  defaultQuickReplyInstallState,
  normalizeQuickReplyInstallState,
} from './core/quick-reply-installer.js';
import {
  createLegacyRulesBackupExport,
  archiveLegacyRules,
  readLegacyRulesBackup,
  stripActiveLegacyRules,
} from './core/legacy-rules.js';

const __getCtx = () => getFreshContext();
const extensionName = 'response-linter';
const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

try { console.info('[Response Linter] 1.4.14 streamlined index loaded'); } catch {}

function getSettingsRoot() {
  try {
    const ctx = __getCtx();
    return ctx?.extensionSettings || (typeof window !== 'undefined' ? window.extension_settings : null) || null;
  } catch {
    return typeof window !== 'undefined' ? window.extension_settings : null;
  }
}

function getCurrentSettingsObject() {
  const root = getSettingsRoot();
  const settings = root?.[extensionName];
  return settings && typeof settings === 'object' ? settings : defaultSettings;
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(defaultSettings));
}

// No active generic rules, rule templates, wizard, guides or statistics.
const defaultSettings = {
  enabled: false,
  autoFix: false,
  defaultAutoFixAction: 'apply', // 'preview' | 'apply'
  removeLeakedReasoning: false,
  repairSdcBoundary: false,
  repairDetailsOrder: false,
  sdcCalendarSource: 'gouhua',
  sdcCustomCalendarJson: '',
  sdcAdvanceMinutes: DEFAULT_ADVANCE_MINUTES,
  structureProfilesVersion: 1,
  structureProfiles: [],
  structureProfileId: '',
  quickReplyInstall: defaultQuickReplyInstallState(),
};

let backendController = null;

(async () => {
  try {
    const { createBackendController } = await import('./core/backend-controller.js');
    backendController = createBackendController(extensionName);
    window.backendController = backendController;
    try { backendController.initialize(getCurrentSettingsObject()); } catch (error) {
      console.warn('[Response Linter] 后端早期初始化失败（稍后重试）:', error);
    }
    try { UIState?.updateStatistics?.(); UIState?.updateStatusIndicator?.(); } catch {}
  } catch (error) {
    console.error('[Response Linter] 后端控制器加载失败，扩展将以降级模式运行:', error);
  }
})();

// Minimal popup fallback. Main panel itself is native DOM, but repair preview
// and host integrations may call callGenericPopup.
(function ensurePopupBridge() {
  try {
    if (!window.callGenericPopup) {
      window.callGenericPopup = function (content, type = 'display', title = '') {
        return new Promise(resolve => {
          const overlay = document.createElement('div');
          overlay.className = 'rl-compat-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px;';
          const modal = document.createElement('div');
          modal.className = 'rl-compat-modal';
          modal.style.cssText = 'background:var(--SmartThemeBlurTintColor,#222);color:var(--SmartThemeBodyColor,#fff);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:8px;max-width:90%;max-height:85vh;overflow:auto;padding:14px;min-width:min(480px,90vw);';
          const h3 = document.createElement('h3');
          h3.textContent = title || (type === 'confirm' ? '确认' : '提示');
          h3.style.marginTop = '0';
          const body = document.createElement('div');
          body.innerHTML = typeof content === 'string' ? content : '';
          const actions = document.createElement('div');
          actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
          const onKey = event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          };
          const finish = value => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(value);
          };
          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'menu_button';
          close.textContent = type === 'confirm' ? '确定' : '关闭';
          close.addEventListener('click', () => finish(true));
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.className = 'menu_button secondary';
          cancel.textContent = '取消';
          cancel.addEventListener('click', () => finish(false));
          if (type === 'confirm') actions.appendChild(cancel);
          actions.appendChild(close);
          modal.append(h3, body, actions);
          overlay.appendChild(modal);
          overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
          document.body.appendChild(overlay);
          document.addEventListener('keydown', onKey, true);
          close.focus?.();
        });
      };
    }
  } catch {}
})();

function showSettingsToast(kind, message, options = {}) {
  try {
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') fn.call(window.toastr, message, '响应检查器', options);
  } catch {}
}

function saveSettings() {
  const ctx = __getCtx();
  const root = ctx?.extensionSettings || getSettingsRoot();
  if (!root || !Object.prototype.hasOwnProperty.call(root, extensionName)) return;
  const settings = root[extensionName] || getSettingsRoot()?.[extensionName] || cloneDefaults();
  root[extensionName] = settings;

  settings.enabled = $('#rl-enabled').prop('checked') === true;
  settings.autoFix = $('#rl-auto-fix').prop('checked') === true;
  settings.defaultAutoFixAction = $('#rl-default-auto-fix-action').val() || 'apply';

  const merged = mergeFeatureSettings(settings, {
    removeLeakedReasoning: $('#rl-remove-leaked-reasoning').prop('checked') === true,
    repairSdcBoundary: $('#rl-repair-sdc-boundary').prop('checked') === true,
    repairDetailsOrder: $('#rl-repair-details-order').prop('checked') === true,
    sdcCalendarSource: $('#rl-sdc-calendar-source').val() || FEATURE_DEFAULTS.sdcCalendarSource,
    sdcCustomCalendarJson: $('#rl-sdc-custom-calendar').val() || '',
    sdcAdvanceMinutes: $('#rl-sdc-advance-minutes').val(),
  });
  Object.assign(settings, merged.fields);

  // Legacy rules are archived once and then removed from active settings.
  // Saving can never write a `rules` array even if one was injected elsewhere.
  const archived = archiveLegacyRules(settings);
  if (Object.keys(archived.fields).length) Object.assign(settings, archived.fields);
  stripActiveLegacyRules(settings);

  if (!Array.isArray(settings.structureProfiles) || !settings.structureProfiles.length) {
    Object.assign(settings, migrateStructureProfileSettings(settings).fields);
  }
  if (settings[STRUCTURE_PROFILES_MIGRATION_KEY] == null) {
    settings[STRUCTURE_PROFILES_MIGRATION_KEY] = STRUCTURE_PROFILES_MIGRATION_VERSION;
  }

  $('#rl-sdc-calendar-source').val(settings.sdcCalendarSource);
  $('#rl-sdc-advance-minutes').val(settings.sdcAdvanceMinutes);
  updateCalendarCustomVisibility();
  for (const warning of merged.warnings) {
    showSettingsToast('warning', escapeHtml(warning), { timeOut: 6000, escapeHtml: false });
  }
  refreshCalendarStatus();
  refreshLegacyBackupStatus();

  try {
    backendController?.updateSettings(settings);
    window.backendController = backendController;
  } catch (error) {
    console.warn('[Response Linter] 后端暂不可用，设置保存在扩展存储中:', error);
  }

  try { if (window.extension_settings) window.extension_settings[extensionName] = settings; } catch {}
  try { UIState?.updateStatistics?.(); UIState?.updateStatusIndicator?.(); } catch {}
  try {
    const acc = __getCtx()?.accountStorage;
    if (acc?.setItem) acc.setItem('response_linter_settings', JSON.stringify(settings));
  } catch {}
  try {
    const saveFn = __getCtx()?.saveSettingsDebounced || window.saveSettingsDebounced;
    if (typeof saveFn === 'function') saveFn();
  } catch {}
}

// ===== calendar (read-only automatic status) =====
function customJsonForTextarea(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return ''; }
  }
  return '';
}

function updateCalendarCustomVisibility() {
  const source = $('#rl-sdc-calendar-source').val();
  $('#rl-sdc-custom-panel').toggle(source === 'custom');
}

function setCalendarStatus(text, isError = false) {
  const element = $('#rl-sdc-calendar-status-text');
  element.text(text || '');
  element.toggleClass('rl-calendar-error', !!isError);
}

function refreshCalendarStatus() {
  try {
    const persisted = getCurrentSettingsObject();
    const source = $('#rl-sdc-calendar-source').val() || persisted.sdcCalendarSource || FEATURE_DEFAULTS.sdcCalendarSource;
    const customJson = $('#rl-sdc-custom-calendar').val() || persisted.sdcCustomCalendarJson || '';
    const result = resolveCalendarAwareness({
      ...persisted,
      sdcCalendarSource: source,
      sdcCustomCalendarJson: customJson,
    }, __getCtx());
    setCalendarStatus(result.message || (result.ok
      ? `${result.sourceLabel}：${describeCalendar(result.calendar)}`
      : `${result.sourceLabel || source}：${result.error || '历法不可用'}`), !result.ok);
    return result;
  } catch (error) {
    setCalendarStatus(`历法状态读取失败：${error.message}`, true);
    return { ok: false, error: error.message };
  }
}

let calendarWatchStop = null;
let calendarRefreshTimer = null;
function ensureCalendarWatch() {
  if (calendarWatchStop) return;
  const ctx = __getCtx() || {};
  calendarWatchStop = watchCalendarAwareness({
    eventSource: ctx.eventSource || null,
    eventTypes: ctx.eventTypes || ctx.event_types || null,
    windowObject: window,
    onChanged: () => {
      if (calendarRefreshTimer) clearTimeout(calendarRefreshTimer);
      calendarRefreshTimer = setTimeout(() => {
        calendarRefreshTimer = null;
        try { refreshCalendarStatus(); } catch {}
      }, 250);
    },
  });
}

// ===== profile persistence / import / export =====
let mainPanel = null;
let quickReplyInstaller = null;
let quickReplyCommand = null;
let qrAutoTimer = null;
let qrAutoAttempts = 0;
let qrAutoStopped = false;
let qrCollisionNotified = false;

function persistStructureProfiles(profiles, activeProfileId) {
  const settings = getCurrentSettingsObject();
  const merged = mergeStructureProfiles(settings, {
    structureProfiles: profiles,
    structureProfileId: activeProfileId,
  });
  if (merged.rejected) return { ok: false, warnings: merged.warnings };
  Object.assign(settings, merged.fields);
  try {
    saveSettings();
  } catch (error) {
    return { ok: false, warnings: [`结构档案保存失败：${error.message}`] };
  }
  return { ok: true, warnings: merged.warnings };
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function refreshLegacyBackupStatus() {
  const backup = readLegacyRulesBackup(getCurrentSettingsObject());
  const status = document.getElementById('rl-legacy-backup-status');
  const button = document.getElementById('rl-legacy-backup-export');
  if (status) {
    status.textContent = backup
      ? `已留档 ${Number(backup.count) || backup.rules?.length || 0} 条旧规则（不执行）。`
      : '没有旧版通用规则留档。';
    status.classList.toggle('rl-calendar-error', false);
  }
  if (button) button.disabled = !backup;
}

function exportLegacyRulesBackup() {
  try {
    const payload = createLegacyRulesBackupExport(getCurrentSettingsObject());
    downloadJson('response-linter-legacy-rules-backup.json', payload);
    showSettingsToast('success', '旧规则备份已导出（仅数据，不可执行）');
  } catch (error) {
    showSettingsToast('error', formatErrorForToast('导出旧规则备份失败：', error), { escapeHtml: false });
  }
}

function ensureStructureImportInput() {
  let input = document.getElementById('rl-structure-import-file');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'rl-structure-import-file';
  input.accept = '.json,application/json';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(input);
  return input;
}

function importConfigFile() {
  try {
    const input = ensureStructureImportInput();
    input.value = '';
    input.onchange = event => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const currentSettings = getCurrentSettingsObject();
          const imported = importStructureSettingsText(e.target.result, currentSettings);
          if (!imported.ok) throw new Error(imported.error);
          const next = imported.settings;
          Object.assign(currentSettings, next);
          // Explicit import replaces stale editor drafts and never activates
          // imported legacy rules (none are present in imported.settings).
          stripActiveLegacyRules(currentSettings);
          $('#rl-sdc-custom-calendar').val(customJsonForTextarea(next.sdcCustomCalendarJson));
          $('#rl-sdc-calendar-source').val(next.sdcCalendarSource);
          $('#rl-remove-leaked-reasoning').prop('checked', next.removeLeakedReasoning === true);
          $('#rl-repair-sdc-boundary').prop('checked', next.repairSdcBoundary === true);
          $('#rl-repair-details-order').prop('checked', next.repairDetailsOrder === true);
          $('#rl-sdc-advance-minutes').val(next.sdcAdvanceMinutes);
          updateCalendarCustomVisibility();
          structureProfileUI.refreshFromSettings({ preserveDraft: false });
          saveSettings();
          showSettingsToast('success', '回复修复方案已导入；旧版规则只留档，不会执行。');
        } catch (error) {
          console.error('导入配置失败:', error);
          showSettingsToast('error', formatErrorForToast('导入失败：', error), { timeOut: 6000, escapeHtml: false });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  } catch (error) {
    showSettingsToast('error', formatErrorToToastSafe('导入配置失败：', error), { escapeHtml: false });
  }
}

function formatErrorToToastSafe(prefix, error) {
  try { return formatErrorForToast(prefix, error); } catch { return prefix + (error?.message || String(error)); }
}

function exportConfigFile() {
  try {
    const currentSettings = getCurrentSettingsObject();
    const collection = readStructureProfiles(currentSettings);
    const payload = createStructureSettingsExport({
      ...currentSettings,
      structureProfilesVersion: collection.version,
      structureProfiles: collection.profiles,
      structureProfileId: collection.activeProfileId,
      removeLeakedReasoning: $('#rl-remove-leaked-reasoning').prop('checked') === true,
      repairSdcBoundary: $('#rl-repair-sdc-boundary').prop('checked') === true,
      repairDetailsOrder: $('#rl-repair-details-order').prop('checked') === true,
      sdcCalendarSource: $('#rl-sdc-calendar-source').val() || currentSettings.sdcCalendarSource,
      sdcCustomCalendarJson: $('#rl-sdc-custom-calendar').val() || currentSettings.sdcCustomCalendarJson,
      sdcAdvanceMinutes: Number($('#rl-sdc-advance-minutes').val()) || DEFAULT_ADVANCE_MINUTES,
    });
    downloadJson('response-linter-structure-settings.json', payload);
    showSettingsToast('success', '回复修复方案配置已导出（含旧规则留档）');
  } catch (error) {
    console.error('导出配置失败:', error);
    showSettingsToast('error', formatErrorToToastSafe('导出配置失败：', error), { escapeHtml: false });
  }
}

// ===== Quick Reply =====
function setQrStatus(text, isError = false) {
  const element = document.getElementById('rl-qr-status-text');
  if (!element) return;
  element.textContent = text || '';
  element.classList.toggle('rl-calendar-error', !!isError);
}

function readPersistedQuickReplyState() {
  try { return normalizeQuickReplyInstallState(getCurrentSettingsObject().quickReplyInstall); }
  catch { return defaultQuickReplyInstallState(); }
}

function hasSettingsNamespace() {
  try {
    const root = __getCtx()?.extensionSettings || getSettingsRoot();
    return !!root && Object.prototype.hasOwnProperty.call(root, extensionName);
  } catch {
    return false;
  }
}

function persistQuickReplyInstallState(state) {
  try {
    if (!hasSettingsNamespace()) throw new Error('扩展设置命名空间尚未就绪');
    const settings = getCurrentSettingsObject();
    settings.quickReplyInstall = normalizeQuickReplyInstallState(state);
    try { if (window.extension_settings) window.extension_settings[extensionName] = settings; } catch {}
    try {
      const acc = __getCtx()?.accountStorage;
      if (acc?.setItem) acc.setItem('response_linter_settings', JSON.stringify(settings));
    } catch {}
    const saveFn = __getCtx()?.saveSettingsDebounced || window.saveSettingsDebounced;
    if (typeof saveFn === 'function') saveFn();
  } catch (error) {
    console.warn('[Response Linter] 保存 Quick Reply 安装标记失败', error);
    throw error;
  }
}

async function runQrRepairAction() {
  if (!backendController?.triggerManualFix) throw new Error('后端尚未就绪');
  const latest = backendController.getLatestAIMessage?.();
  if (!latest) return { success: false, reason: '没有找到可修复的 AI 回复。' };
  const result = await backendController.triggerManualFix(String(latest.id));
  if (result?.metadata?.requiresConfirmation) {
    showSettingsToast('info', '已打开修复预览，请确认或取消。');
    return { success: true, pendingConfirmation: true };
  }
  if (result?.success) {
    showSettingsToast('success', '修复已应用');
    return { success: true };
  }
  return { success: false, reason: result?.reason || '修复失败' };
}

function ensureQuickReplyCommand() {
  if (quickReplyCommand?.ok || quickReplyCommand?.state === 'collision') return quickReplyCommand;
  quickReplyCommand = registerQuickReplyCommand({
    ctx: __getCtx() || {},
    runRepair: runQrRepairAction,
    toastr: window.toastr,
  });
  if (!quickReplyCommand.ok && quickReplyCommand.state === 'collision') {
    setQrStatus(quickReplyCommand.reason, true);
    if (!qrCollisionNotified) {
      qrCollisionNotified = true;
      showSettingsToast('warning', escapeHtml(quickReplyCommand.reason), { escapeHtml: false, timeOut: 8000 });
    }
    qrAutoStopped = true;
    if (qrAutoTimer) clearTimeout(qrAutoTimer);
  }
  return quickReplyCommand;
}

function refreshQuickReplyStatus() {
  if (!quickReplyCommand || quickReplyCommand.state === 'unavailable') {
    setQrStatus('Quick Reply 斜杠命令尚未就绪；正在等待宿主 API。');
    return;
  }
  if (quickReplyCommand.state === 'collision') {
    setQrStatus(quickReplyCommand.reason, true);
    return;
  }
  if (!quickReplyInstaller) {
    setQrStatus('Quick Reply API 尚未就绪；可稍后重试。');
    return;
  }
  const status = quickReplyInstaller.getStatus();
  setQrStatus(status.message || '尚未检查 Quick Reply 安装状态。', ['error', 'collision', 'duplicate'].includes(status.state));
}

function ensureQuickReplyInstaller() {
  if (quickReplyInstaller) return quickReplyInstaller;
  if (!quickReplyCommand?.ok) return null;
  quickReplyInstaller = createQuickReplyInstaller({
    getApi: () => globalThis.quickReplyApi,
    getCommandReady: () => quickReplyCommand || { ok: false, state: 'unavailable' },
    readState: readPersistedQuickReplyState,
    writeState: persistQuickReplyInstallState,
    notify: (message, isError) => setQrStatus(message, isError),
  });
  return quickReplyInstaller;
}

function scheduleQrAutoCheck(delay = 1000) {
  if (qrAutoStopped) return;
  if (qrAutoTimer) clearTimeout(qrAutoTimer);
  qrAutoTimer = setTimeout(() => {
    qrAutoTimer = null;
    void autoCheckQuickReply();
  }, delay);
}

async function autoCheckQuickReply() {
  if (qrAutoStopped) return;
  ensureQuickReplyCommand();
  if (quickReplyCommand?.state === 'collision') {
    refreshQuickReplyStatus();
    return;
  }
  const installer = ensureQuickReplyInstaller();
  if (!installer) {
    refreshQuickReplyStatus();
    qrAutoAttempts++;
    if (qrAutoAttempts < 20) scheduleQrAutoCheck();
    return;
  }
  const status = await installer.ensureInstalled();
  setQrStatus(status?.message || '', ['error', 'collision', 'duplicate'].includes(status?.state));
  if (['installed', 'removed', 'collision', 'duplicate'].includes(status?.state)) {
    qrAutoStopped = true;
    if (qrAutoTimer) clearTimeout(qrAutoTimer);
    return;
  }
  qrAutoAttempts++;
  if (qrAutoAttempts < 20) scheduleQrAutoCheck();
}

function startQuickReplySurface() {
  qrAutoStopped = false;
  qrAutoAttempts = 0;
  ensureQuickReplyCommand();
  refreshQuickReplyStatus();
  scheduleQrAutoCheck(200);
}

async function restoreQuickReplyButton() {
  ensureQuickReplyCommand();
  if (quickReplyCommand?.state === 'collision') {
    refreshQuickReplyStatus();
    return;
  }
  const installer = ensureQuickReplyInstaller();
  if (!installer) {
    setQrStatus('Quick Reply API 尚未就绪，无法恢复；请稍后重试。', true);
    return;
  }
  const status = await installer.restore();
  setQrStatus(status?.message || '', ['error', 'collision', 'duplicate'].includes(status?.state));
}

// ===== panel / launchers =====
function onPanelOpen() {
  try { structureProfileUI.onPanelOpen(); } catch {}
  try { refreshCalendarStatus(); } catch {}
  try { refreshQuickReplyStatus(); } catch {}
  try { refreshLegacyBackupStatus(); } catch {}
  try { UIState?.updateStatistics?.(); UIState?.updateStatusIndicator?.(); } catch {}
}

function setupLaunchers(settingsHtml) {
  mainPanel = setupMainPanel({
    settingsHtml,
    onOpen: onPanelOpen,
    onQrRestore: () => { void restoreQuickReplyButton(); },
    onStatusText: () => '响应检查器',
  });
  setupDiagnosticsUI(getCurrentSettingsObject);
  structureProfileUI.initialize({
    getSettings: getCurrentSettingsObject,
    persistProfiles: persistStructureProfiles,
    notify: (text, isError) => {
      if (window.toastr && isError) window.toastr.warning?.(escapeHtml(text), '响应检查器', { escapeHtml: false });
    },
  });
  const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
  if (target?.length) installDrawerLauncher(target[0]);
  else installDrawerLauncher(document.body);
  // Direct binding on the native inline-drawer header guarantees the panel
  // still opens if the host's drawer toggle stops event propagation. The
  // delegated handler in setupMainPanel remains the fallback for late/wand DOM.
  const drawerLauncher = document.getElementById('rl-open-main-panel');
  if (drawerLauncher && drawerLauncher.__rlDirectBound !== true) {
    drawerLauncher.__rlDirectBound = true;
    drawerLauncher.addEventListener('click', event => {
      event.preventDefault();
      mainPanel?.open();
    });
    drawerLauncher.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      mainPanel?.open();
    });
  }
  installWandLauncher({ attempts: 16, delayMs: 250 });
}

// ===== settings lifecycle =====
async function loadSettings() {
  const ctx = __getCtx();
  const root = ctx?.extensionSettings || getSettingsRoot();
  const hasKey = Object.prototype.hasOwnProperty.call(root || {}, extensionName);
  let backup = null;
  try {
    const raw = ctx?.accountStorage?.getItem?.('response_linter_settings');
    if (raw) backup = JSON.parse(raw);
  } catch (error) {
    console.warn('[Response Linter] 读取 accountStorage 备份失败', error);
  }
  let settings = hasKey ? (root[extensionName] || null) : null;
  if (!settings && backup) settings = backup;
  if (!settings || typeof settings !== 'object') settings = cloneDefaults();

  // One-time inert archive of generic rules, then remove active execution data.
  const archived = archiveLegacyRules(settings);
  if (Object.keys(archived.fields).length) Object.assign(settings, archived.fields);
  const strippedLegacyRules = stripActiveLegacyRules(settings);

  // One-way, idempotent profile migration. Selected profile/order/body/time are preserved.
  const profileMigration = migrateStructureProfileSettings(settings);
  if (Object.keys(profileMigration.fields).length) Object.assign(settings, profileMigration.fields);

  if (hasKey) {
    try { root[extensionName] = settings; } catch {}
    try { if (window.extension_settings) window.extension_settings[extensionName] = settings; } catch {}
  }

  const features = readFeatureSettings(settings);
  $('#rl-enabled').prop('checked', settings.enabled === true);
  $('#rl-auto-fix').prop('checked', settings.autoFix === true);
  $('#rl-default-auto-fix-action').val(settings.defaultAutoFixAction || 'apply');
  $('#rl-remove-leaked-reasoning').prop('checked', features.removeLeakedReasoning);
  $('#rl-repair-sdc-boundary').prop('checked', features.repairSdcBoundary);
  $('#rl-repair-details-order').prop('checked', features.repairDetailsOrder);
  $('#rl-sdc-calendar-source').val(features.sdcCalendarSource);
  $('#rl-sdc-custom-calendar').val(customJsonForTextarea(features.sdcCustomCalendarJson));
  if (features.sdcCalendarSource === 'custom') {
    const seeded = seedCustomCalendarDraft($('#rl-sdc-custom-calendar').val(), features.sdcCustomCalendarJson);
    if (seeded.seeded) {
      $('#rl-sdc-custom-calendar').val(seeded.text);
      settings.sdcCustomCalendarJson = seeded.text.trim();
    }
  }
  $('#rl-sdc-advance-minutes').val(features.sdcAdvanceMinutes);
  updateCalendarCustomVisibility();
  try { structureProfileUI.refreshFromSettings({ preserveDraft: false }); } catch (error) {
    console.warn('[Response Linter] 档案界面刷新失败', error);
  }
  try { ensureCalendarWatch(); } catch {}
  refreshCalendarStatus();
  refreshLegacyBackupStatus();

  try {
    if (!backendController) throw new Error('backendController未就绪');
    if (backendController.isInitialized) backendController.updateSettings(settings);
    else backendController.initialize(settings);
    window.backendController = backendController;
  } catch (error) {
    console.warn('[Response Linter] 后端未就绪，UI 先行加载:', error);
  }

  // Migrated fields/archives are written back once; the archive never gets
  // overwritten on later loads because archiveLegacyRules sees it already.
  if ((profileMigration.migrated || archived.archived || strippedLegacyRules) && hasKey) {
    try {
      root[extensionName] = settings;
      if (window.extension_settings) window.extension_settings[extensionName] = settings;
      try {
        const acc = ctx?.accountStorage;
        if (acc?.setItem) acc.setItem('response_linter_settings', JSON.stringify(settings));
      } catch {}
      const saveFn = ctx?.saveSettingsDebounced || window.saveSettingsDebounced;
      if (typeof saveFn === 'function') saveFn();
    } catch (error) {
      console.warn('[Response Linter] 迁移写回失败:', error);
    }
  }

  try { UIState?.updateStatistics?.(); UIState?.updateStatusIndicator?.(); } catch {}
}

// ===== preview/confirmation events =====
let activeConfirmation = null;

async function showStructureConfirmation(detail) {
  if (!detail || !backendController?.isPreviewCurrent(detail.token)) return;
  if (activeConfirmation?.token === detail.token) return;
  activeConfirmation?.popup.close(false, true);
  const messageId = String(detail.messageId ?? '');
  const warnings = Array.isArray(detail.warnings) ? detail.warnings : [];
  const preview = String(detail.newContent ?? '');
  const strategyNames = {
    'remove-leaked-reasoning': '清理泄漏推理',
    'sdc-content-boundary': '修复正文 / 时间边界',
    'details-outside-content-order': '修复末尾块顺序与配对',
  };
  const strategyLabel = String(detail.strategy || '').split(' | ').map(name => strategyNames[name] || name).join('、') || '结构修复';
  const warningHtml = warnings.length
    ? `<div class="rl-confirmation-warnings"><strong>注意：</strong><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
  const dialogHtml = `
    <div class="rl-fix-confirmation-dialog">
      <p><strong>修复策略</strong>：${escapeHtml(strategyLabel)}</p>
      <p><strong>消息</strong>：${escapeHtml(messageId)}</p>
      ${warningHtml}
      <h4>修复后内容预览</h4>
      <pre style="max-height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);border:1px solid var(--SmartThemeBorderColor);padding:10px;border-radius:4px;text-align:left;">${escapeHtml(preview)}</pre>
    </div>
  `;
  const popup = openRepairPreview(dialogHtml, () => backendController?.isPreviewCurrent(detail.token));
  const entry = { token: detail.token, popup };
  activeConfirmation = entry;
  let confirmed = false;
  try {
    const result = await popup.result;
    if (result.invalidated) { await backendController?.confirmFix(messageId, false, detail.token); return; }
    confirmed = result.confirmed;
    const applied = await backendController?.confirmFix(messageId, confirmed, detail.token);
    if (confirmed && applied?.success) showSettingsToast('success', '修复已应用');
    else if (!confirmed) showSettingsToast('info', '修复已取消');
    else showSettingsToast('error', applied?.reason || applied?.metadata?.reason || '确认修复失败');
  } catch (error) {
    console.error('[Response Linter] 确认修复失败:', error);
    showSettingsToast('error', '确认修复失败');
  } finally {
    if (activeConfirmation === entry) activeConfirmation = null;
    try { UIState?.updateStatistics?.(); UIState?.updateStatusIndicator?.(); } catch {}
  }
}

function setupRepairEventHandlers() {
  document.addEventListener('responseLinter.previewInvalidated', event => {
    if (activeConfirmation?.token === event.detail?.token) activeConfirmation.popup.close(false, true);
  });
  document.addEventListener('responseLinter.confirmationRequired', event => {
    void showStructureConfirmation(event.detail);
  });
  document.addEventListener('responseLinter.fixWarning', event => {
    const warnings = event.detail?.warnings || [];
    if (warnings.length) showSettingsToast('warning', joinWarningToasts(warnings), { timeOut: 8000, escapeHtml: false });
  });
  const refreshActions = () => {
    try { UIState?.updateStatistics?.(); UIState?.updateStatusIndicator?.(); } catch {}
  };
  document.addEventListener('responseLinter.fixApplied', refreshActions);
  document.addEventListener('responseLinter.fixStatisticsChanged', refreshActions);
  document.addEventListener('responseLinter.fixConfirmed', refreshActions);
  document.addEventListener('responseLinter.fixCancelled', refreshActions);
  document.addEventListener('responseLinter.fixUndone', refreshActions);
}

// ===== events =====
function setupEventHandlers() {
  $('#rl-enabled').on('change', function () {
    saveSettings();
    showSettingsToast('info', $(this).prop('checked') ? '响应检查器已启用' : '响应检查器已禁用');
  });

  $('#rl-auto-fix').on('change', saveSettings);
  $('#rl-default-auto-fix-action').on('change', saveSettings);

  for (const id of ['#rl-remove-leaked-reasoning', '#rl-repair-sdc-boundary', '#rl-repair-details-order']) {
    $(id).on('change', saveSettings);
  }

  $('#rl-sdc-calendar-source').on('change', function () {
    if ($(this).val() === 'custom') {
      const saved = getCurrentSettingsObject();
      const seeded = seedCustomCalendarDraft($('#rl-sdc-custom-calendar').val(), saved.sdcCustomCalendarJson);
      if (seeded.text !== $('#rl-sdc-custom-calendar').val()) $('#rl-sdc-custom-calendar').val(seeded.text);
    }
    updateCalendarCustomVisibility();
    saveSettings();
  });
  $('#rl-sdc-advance-minutes').on('change', saveSettings);
  $('#rl-sdc-custom-calendar').on('change', function () {
    if ($('#rl-sdc-calendar-source').val() === 'custom') saveSettings();
  });

  $('#rl-sdc-export-config').on('click', exportConfigFile);
  $('#rl-sdc-import-config').on('click', importConfigFile);
  $('#rl-legacy-backup-export').on('click', exportLegacyRulesBackup);

  $('#rl-manual-fix').on('click', async function () {
    const button = $(this);
    const originalText = button.text();
    try {
      button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> 修复中…');
      const latestMessageId = UIState.getLatestAIMessageId();
      if (latestMessageId === null) {
        showSettingsToast('warning', '没有找到可修复的 AI 回复');
        return;
      }
      const result = await backendController.triggerManualFix(latestMessageId);
      if (result?.metadata?.requiresConfirmation) {
        showSettingsToast('info', '已打开修复预览，请确认或取消。');
      } else if (result?.success) {
        showSettingsToast('success', '修复已应用');
      } else if (!result?.suppressed) {
        showSettingsToast('error', escapeHtml(result?.reason || '修复失败'), { escapeHtml: false });
      } else {
        showSettingsToast('warning', escapeHtml(result.reason), { escapeHtml: false });
      }
      if (Array.isArray(result?.warnings) && result.warnings.length) {
        showSettingsToast('warning', joinWarningToasts(result.warnings), { timeOut: 8000, escapeHtml: false });
      }
    } catch (error) {
      console.error('手动修复失败:', error);
      showSettingsToast('error', '修复过程出错');
    } finally {
      button.html(originalText);
      try { UIState.updateStatistics(); } catch {}
    }
  });

  $('#rl-undo-fix').on('click', async function () {
    $(this).prop('disabled', true);
    try {
      const id = UIState.getLatestAIMessageId();
      if (id === null) return;
      const result = await backendController.undoFix(id);
      if (result?.success) showSettingsToast('success', '修复已撤销');
      else showSettingsToast('warning', result?.metadata?.reason || result?.reason || '撤销失败');
    } finally {
      try { UIState.updateStatistics(); } catch {}
    }
  });
}

// ===== initialization =====
jQuery(async () => {
  try {
    const ctx = __getCtx();
    let settingsHtml;
    const extensionNameBase = (() => {
      try {
        const match = extensionFolderPath.match(/\/scripts\/extensions\/(.+)$/);
        return match ? match[1] : 'third-party/Response-Linter';
      } catch { return 'third-party/Response-Linter'; }
    })();
    const templatesBase = `${extensionNameBase}/presentation/templates`;
    if (ctx && typeof ctx.renderExtensionTemplateAsync === 'function') {
      settingsHtml = await ctx.renderExtensionTemplateAsync(templatesBase, 'settings');
    } else {
      settingsHtml = await $.get(`${extensionFolderPath}/presentation/templates/settings.html`);
    }

    const { UIStateManager } = await import('./presentation/modules/ui-state-manager.js');
    await UIStateManager.initialize();

    setupLaunchers(settingsHtml);
    setupEventHandlers();
    setupRepairEventHandlers();
    startQuickReplySurface();

    try {
      const qctx = __getCtx();
      const qes = qctx?.eventSource || window.eventSource;
      const appReady = (qctx?.eventTypes || qctx?.event_types)?.APP_READY;
      if (qes && appReady && typeof qes.once === 'function') {
        qes.once(appReady, () => {
          startQuickReplySurface();
          ensureCalendarWatch();
          refreshCalendarStatus();
        });
      }
    } catch {}

    const getES = () => {
      const current = __getCtx();
      return {
        ctx: current,
        es: current?.eventSource || window.eventSource,
        et: current?.eventTypes || current?.event_types || window.event_types,
        settingsRoot: current?.extensionSettings || window.extension_settings,
      };
    };

    const tryImmediate = () => {
      const { settingsRoot } = getES();
      if (settingsRoot && Object.prototype.hasOwnProperty.call(settingsRoot, extensionName)) {
        void loadSettings();
        return true;
      }
      return false;
    };

    let loadedHandled = false;
    const ensureNamespaceThenLoad = () => {
      if (loadedHandled) return;
      loadedHandled = true;
      try {
        const { ctx: current, settingsRoot } = getES();
        if (settingsRoot && !Object.prototype.hasOwnProperty.call(settingsRoot, extensionName)) {
          let seed = null;
          try {
            const raw = current?.accountStorage?.getItem?.('response_linter_settings');
            if (raw) seed = JSON.parse(raw);
          } catch {}
          if (!seed) seed = cloneDefaults();
          settingsRoot[extensionName] = seed;
          try { if (window.extension_settings) window.extension_settings[extensionName] = seed; } catch {}
          const saveFn = current?.saveSettingsDebounced || window.saveSettingsDebounced;
          if (typeof saveFn === 'function') saveFn();
        }
      } catch (error) {
        console.warn('[Response Linter] 创建设置命名空间失败', error);
      }
      void loadSettings();
    };

    let listenersBound = false;
    const tryBind = () => {
      const { es, et } = getES();
      if (!es || !et || listenersBound) return !!listenersBound;
      es.once(et.EXTENSION_SETTINGS_LOADED, ensureNamespaceThenLoad);
      es.once(et.SETTINGS_LOADED, ensureNamespaceThenLoad);
      if (et.CHAT_CHANGED && typeof es.on === 'function') {
        es.on(et.CHAT_CHANGED, () => {
          try { UIState.updateStatistics(); UIState.updateStatusIndicator(); } catch {}
          try { refreshCalendarStatus(); } catch {}
          try { refreshQuickReplyStatus(); } catch {}
        });
      }
      listenersBound = true;
      return true;
    };

    if (!tryBind()) {
      let attempts = 0;
      const retry = () => {
        if (tryBind()) return;
        if (++attempts > 20) return;
        setTimeout(retry, 250);
      };
      setTimeout(retry, 250);
    }

    tryImmediate();
    setTimeout(() => { tryImmediate(); }, 5000);
    setTimeout(() => {
      const { settingsRoot } = getES();
      if (settingsRoot && !Object.prototype.hasOwnProperty.call(settingsRoot, extensionName)) {
        ensureNamespaceThenLoad();
      }
    }, 8000);

    window.ResponseLinter = window.ResponseLinter || {};
    window.ResponseLinter.version = '1.4.14';
    window.ResponseLinter.backendController = backendController;
    console.info('[Response Linter] 1.4.14 初始化完成');
  } catch (error) {
    console.error('[Response Linter] 扩展初始化失败:', error);
    showSettingsToast('error', '响应检查器扩展加载失败');
    window.ResponseLinter = window.ResponseLinter || {};
    window.ResponseLinter.initializationError = error;
  }
});
