// Response Linter 扩展 - 主入口文件
// UI层实现与真实后端功能集成
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
import {
  installDrawerLauncher,
  installWandLauncher,
  setupMainPanel,
} from './presentation/modules/main-panel-ui.js';
import {
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

// 统一通过 getContext() 与酒馆交互，避免直接导入内部文件。
// 优先实际宿主 window.SillyTavern.getContext，每次现取。
const __getCtx = () => getFreshContext();
const __ST = (() => {
  const ctx = __getCtx() || {};
  return {
    extension_settings: ctx.extensionSettings || window.extension_settings || {},
    saveSettingsDebounced: ctx.saveSettingsDebounced || window.saveSettingsDebounced || (() => {}),
    renderExtensionTemplateAsync: ctx.renderExtensionTemplateAsync || null,
    callGenericPopup: ctx.callGenericPopup || window.callGenericPopup,
    POPUP_TYPE: ctx.POPUP_TYPE || { CONFIRM: 'confirm', DISPLAY: 'display', INPUT: 'input' },
    POPUP_RESULT: ctx.POPUP_RESULT || { AFFIRMATIVE: true, NEGATIVE: false },
  };
})();
// 为保持现有代码最小改动，映射到本地常量（不再直接从内部文件导入）
const extension_settings = __ST.extension_settings;
const saveSettingsDebounced = __ST.saveSettingsDebounced;
const callGenericPopup = __ST.callGenericPopup;
const POPUP_TYPE = __ST.POPUP_TYPE;
const POPUP_RESULT = __ST.POPUP_RESULT;


// 扩展配置
const extensionName = 'response-linter';
// 以当前模块URL为基准解析扩展根目录，避免大小写/路径不一致导致模板404
const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

// 调试标记：确认脚本已被加载
try { console.info('[Response Linter] index.js loaded'); } catch (e) {}


// 后端控制器实例（使用动态 import 以便捕获下游语法错误）
let backendController = null;

(async () => {
  try {
    const { createBackendController } = await import('./core/backend-controller.js');
    backendController = createBackendController(extensionName);
    console.info('[Response Linter] backend controller ready');
    try {
      const settings = (extension_settings && extension_settings[extensionName]) || defaultSettings;
      backendController.initialize(settings);
      window.backendController = backendController;
      console.info('[Response Linter] backend initialized (early)');
    } catch (initErr) {
      console.warn('[Response Linter] 后端早期初始化失败（稍后由loadSettings重试）:', initErr);
    }
  } catch (e) {
    console.error('[Response Linter] 后端控制器加载失败，扩展将以降级模式运行:', e);
  }
})();



// 兼容性桥：如果宿主环境未通过 getContext().callGenericPopup 暴露弹窗，则将核心的 callGenericPopup 挂到全局
try {
  const ctx = __getCtx();
  const popup = (ctx && ctx.callGenericPopup) ? ctx.callGenericPopup : callGenericPopup;
  if (popup && !window.callGenericPopup) window.callGenericPopup = popup;
} catch (e) {
  if (!window.callGenericPopup && callGenericPopup) window.callGenericPopup = callGenericPopup;
}

// 降级弹窗桥：当宿主未暴露 getContext()/callGenericPopup 时，提供最小可用的标准弹窗实现
(function ensurePopupBridge(){
  try {
    if (typeof window.callGenericPopup === 'function') return; // 已有实现

    window.callGenericPopup = function(content, type = 'display', title = '', options = {}) {
      return new Promise(resolve => {
        try {
          const overlay = document.createElement('div');
          overlay.className = 'rl-compat-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

          const modal = document.createElement('div');
          modal.className = 'rl-compat-modal';
          const cs = getComputedStyle(document.documentElement);
          const bg = cs.getPropertyValue('--SmartThemeBlurTintColor').trim() || '#2a2a2a';
          const fg = cs.getPropertyValue('--SmartThemeBodyColor').trim() || '#ffffff';
          const bd = cs.getPropertyValue('--SmartThemeBorderColor').trim() || 'rgba(255,255,255,0.15)';
          const minw = options.wide ? '640px' : '480px';
          modal.style.cssText = `background:${bg};color:${fg};border:1px solid ${bd};border-radius:8px;min-width:${minw};max-width:90%;max-height:80vh;overflow:auto;box-shadow:0 6px 24px rgba(0,0,0,.35);`;

          const header = document.createElement('div');
          header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid '+bd+';';
          const h3 = document.createElement('h3');
          h3.textContent = title || '';
          h3.style.cssText = 'margin:0;font-size:16px;font-weight:600;';
          const close = document.createElement('button');
          close.textContent = '×';
          close.className = 'menu_button';
          close.style.cssText = 'min-width:auto;padding:4px 10px;';
          header.appendChild(h3); header.appendChild(close);

          const body = document.createElement('div');
          body.style.cssText = 'padding:12px 16px;'+(options.allowVerticalScrolling? 'overflow-y:auto;max-height:60vh;' : '');
          if (content && content.jquery) {
            body.appendChild(content[0]);
          } else if (content instanceof HTMLElement) {
            body.appendChild(content);
          } else {
            body.innerHTML = (typeof content === 'string') ? content : String(content ?? '');
          }

          const footer = document.createElement('div');
          footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid '+bd+';';

          let buttons = [];
          if (Array.isArray(options.customButtons) && options.customButtons.length) {
            buttons = options.customButtons.map(b => ({ text: b.text || '确定', result: b.result, classes: Array.isArray(b.classes)? b.classes : ['menu_button'] }));
          } else if ((type||'').toLowerCase() === 'confirm') {
            buttons = [
              { text: options.okButton || '确定', result: true, classes: ['menu_button'] },
              { text: options.cancelButton || '取消', result: false, classes: ['menu_button','secondary'] },
            ];
          } else {
            buttons = [ { text: options.okButton || '关闭', result: true, classes: ['menu_button'] } ];
          }

          buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.textContent = b.text;
            btn.className = (b.classes||[]).join(' ');
            btn.addEventListener('click', () => { cleanup(); resolve(b.result); });
            footer.appendChild(btn);
          });

          modal.appendChild(header);
          modal.appendChild(body);
          modal.appendChild(footer);
          overlay.appendChild(modal);
          document.body.appendChild(overlay);

          function cleanup(){ try { overlay.remove(); } catch(e){} }
          close.addEventListener('click', () => { cleanup(); resolve(false); });
          overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
          const onKey = (ev) => { if (ev.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(); resolve(false); } };
          document.addEventListener('keydown', onKey);
        } catch (err) {
          console.warn('Fallback callGenericPopup failed:', err);
          resolve(false);
        }
      });
    };
  } catch(e) { /* ignore */ }
})();


// 默认设置结构
const defaultSettings = {
  enabled: false,
  autoFix: false,
  defaultAutoFixAction: 'apply', // 'preview' | 'apply'
  // 三个结构清理开关默认关闭，不影响老用户既有规则与行为。
  removeLeakedReasoning: false,
  repairSdcBoundary: false,
  repairDetailsOrder: false,
  detailsMonologueKeyword: FEATURE_DEFAULTS.detailsMonologueKeyword,
  detailsChoicesKeyword: FEATURE_DEFAULTS.detailsChoicesKeyword,
  sdcCalendarSource: 'gouhua',
  sdcCustomCalendarJson: '',
  sdcAdvanceMinutes: DEFAULT_ADVANCE_MINUTES,
  structureProfilesVersion: 1,
  structureProfiles: [],
  structureProfileId: '',
  quickReplyInstall: defaultQuickReplyInstallState(),
  rules: [
    {
      id: 'thinking-content-demo',
      name: '思维链与内容格式',
      description: '确保AI回复包含思考过程和内容两个部分',
      enabled: true,
      requiredContent: ['<thinking>', '</thinking>', '<content>', '</content>'],
      fixStrategy: 'thinking-content',
      createdAt: new Date().toISOString(),
    },
  ],
  notifications: {
    enabled: true,
    duration: 5,
    showSuccess: true,
  },
  statistics: {
    validations: 0,
    fixes: 0,
    successRate: 100,
  },
};

// UIState对象已移除 - 功能已迁移到UIStateManager模块
// 通过模块化系统，UIState现在通过window.UIState全局访问
//
// 原始对象定义范围: 44-65行 (22行代码)
// 迁移位置: presentation/modules/ui-state-manager.js
// 全局访问: window.UIState (向后兼容)
// 模块访问: window.ResponseLinter.UIState
//
// 主要功能:
// - 状态属性: isExtensionEnabled, isAutoFixEnabled, rules, currentEditingRule, isGuideExpanded
// - getLatestAIMessageId() - 获取最新AI消息ID
// - updateStatusIndicator() - 更新状态指示器
// - updateStatistics() - 更新统计显示
// - toggleGuide() / loadGuideState() - 指引控制
// - checkAutoExpandGuide() - 自动展开检查
//
// 循环依赖解决:
// 原循环: UIState.rules ↔ RulesManager ↔ RuleEditor
// 现状态: 通过模块系统统一管理，避免循环依赖

// 真实验证和通知功能
// ValidationFunctions对象已移除 - 功能已迁移到ValidationFunctionsUI模块
// 通过模块化系统，ValidationFunctions现在通过window.ValidationFunctions全局访问

/**
 * 显示修复确认对话框
 * @param {string} messageId - 消息ID
 * @param {string} originalContent - 原始内容
 * @param {string} newContent - 修复后内容
 * @param {string} strategy - 修复策略
 */
async function showFixConfirmationDialog(messageId, originalContent, newContent, strategy, warnings = []) {
  const strategyNames = {
    'thinking-content': '思维链格式修复',
    'add-missing-tags': '添加缺失标签',
    custom: '自定义修复',
    'remove-leaked-reasoning': '清理泄漏推理',
    'sdc-content-boundary': '修复 SDC/正文边界',
    'details-outside-content-order': '修复正文外折叠块顺序与配对',
  };

  const strategyName = (strategyNames[strategy] || strategy || '').split(' | ').map(name => strategyNames[name] || name).join(' + ');
  // 预览展示策略：默认全量；超过阈值时使用 <details> 折叠以保护性能
  const LONG_PREVIEW_THRESHOLD = 1000; // 1000 字符保护阈值（约等于 1000 个中文汉字）
  const isLongPreview = (newContent || '').length > LONG_PREVIEW_THRESHOLD;
  const preview = newContent;
  const warningHtml = Array.isArray(warnings) && warnings.length
    ? `<div class="rl-confirmation-warnings"><strong>注意：</strong><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';

  const dialogContent = `
    <div class="rl-fix-confirmation-dialog">
      <h3>确认自动修复</h3>
      <p><strong>修复策略</strong>: ${strategyName}</p>
      <p><strong>消息ID</strong>: ${messageId}</p>
      ${warningHtml}

      <div class="rl-content-preview">
        <h4>修复后内容预览：</h4>
        ${isLongPreview ? `
          <details style="text-align: left;">
            <summary style="cursor: pointer; user-select: none; color: var(--SmartThemeEmColor);">内容较长，点击展开/收起</summary>
            <pre style="max-height: 60vh; max-height: 60svh; max-height: 60dvh; overflow-y: auto; background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 10px; border-radius: 4px; text-align: left; white-space: pre-wrap;">${escapeHtml(preview)}</pre>
          </details>
        ` : `
            <pre style="max-height: 60vh; max-height: 60svh; max-height: 60dvh; overflow-y: auto; background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 10px; border-radius: 4px; text-align: left; white-space: pre-wrap;">${escapeHtml(preview)}</pre>
        `}

      </div>
    </div>
  `;

  try {
    const result = await callGenericPopup(dialogContent, POPUP_TYPE.CONFIRM, '', {
      wide: false,
      customButtons: [
        {
          text: '应用修复',
          result: POPUP_RESULT.AFFIRMATIVE,
          classes: ['menu_button'],
        },
        {
          text: '取消',
          result: POPUP_RESULT.NEGATIVE,
          classes: ['menu_button', 'secondary'],
        },
      ],
    });

    if (result === POPUP_RESULT.AFFIRMATIVE) {
      // 用户确认修复
      try {
        if (!backendController) { throw new Error('backendController未就绪'); }
        const confirmResult = await backendController.confirmFix(messageId, true);
        if (confirmResult.success) {
          toastr.success('修复已应用', '响应检查器');
        } else {
          toastr.error(confirmResult.reason || '修复确认失败', '响应检查器');
        }
      } catch (error) {
        console.error('确认修复失败:', error);
        toastr.error('确认过程出错', '响应检查器');
      }
    } else {
      // 用户取消修复
      try {
        if (!backendController) { throw new Error('backendController未就绪'); }
        await backendController.confirmFix(messageId, false);
        toastr.info('修复已取消', '响应检查器');
      } catch (error) {
        console.error('取消修复失败:', error);
      }
    }
  } catch (error) {
    console.error('显示修复确认对话框失败:', error);
    toastr.error('显示确认对话框出错', '响应检查器');
  }
}

// RulesManager对象已移除 - 功能已迁移到RulesManagerUI模块
// 通过模块化系统，RulesManager现在通过window.RulesManager全局访问
//
// 原始对象定义范围: 252-418行 (167行代码)
// 迁移位置: presentation/modules/rules-manager-ui.js
// 全局访问: window.RulesManager (向后兼容)
// 模块访问: window.ResponseLinter.RulesManager
//
// 主要功能:
// - renderRulesList() - 渲染规则列表
// - createRuleElement() - 创建规则元素
// - addRule() / editRule() / deleteRule() - 规则CRUD操作
// - toggleRule() - 规则状态切换
// - saveRules() - 规则持久化
// - exportRules() / importRules() - 规则导入导出

// RulesManager的addTemplate方法已移除
// 功能已完整迁移到RulesManagerUI模块中

// RuleEditor对象已移除 - 功能已迁移到RuleEditorUI模块
// 通过模块化系统，RuleEditor现在通过window.RuleEditor全局访问
//
// 原始对象定义范围: 271-474行 (204行代码)
// 迁移位置: presentation/modules/rule-editor-ui.js
// 全局访问: window.RuleEditor (向后兼容)
// 模块访问: window.ResponseLinter.RuleEditor
//
// 主要功能:
// - showAddModal() / showEditModal() - 模态框显示控制
// - showModal() / hideModal() - 模态框基础控制
// - addContentTag() / removeContentTag() - 标签管理
// - updateTagsList() - 标签列表更新
// - enableDragSort() - 拖拽排序功能
// - toggleCustomStrategy() - 策略字段切换
// - saveRule() - 规则保存 (已移除，解决循环依赖)
//
// 循环依赖解决:
// 原循环: RuleEditor.saveRule() → RulesManager.addRule()/editRule() →
//         RulesManager.renderRulesList() → createRuleElement() →
//         编辑按钮绑定 → RuleEditor.showEditModal()
// 现状态: 通过模块系统统一管理，避免循环依赖

// ConfigWizard对象已移除 - 功能已迁移到ConfigWizardUI模块
// 通过模块化系统，ConfigWizard现在通过window.ConfigWizard全局访问
//
// 原始对象定义范围: 707-1153行 (447行代码)
// 迁移位置: presentation/modules/config-wizard-ui.js
// 全局访问: window.ConfigWizard (向后兼容)
// 模块访问: window.ResponseLinter.ConfigWizard
//
// 主要功能:
// - show() / hide() - 显示/隐藏配置向导
// - next() / prev() / finish() - 向导流程控制
// - validateCurrentStep() - 步骤验证
// - testRule() - 规则测试功能
// - generateRuleData() - 生成规则数据
//
// 依赖关系:
// - RulesManager.addRule() - 创建规则
// - backendController - 规则测试
// - toastr - 通知显示
// - jQuery - DOM操作

// ConfigWizard对象的所有孤立方法已移除
// 所有功能已完整迁移到ConfigWizardUI模块中

// ===== 结构清理 / SDC 历法设置 =====
const getFeatureSettings = readFeatureSettings;

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

function getCurrentSettingsObject() {
  try {
    const ctx = __getCtx();
    const root = ctx?.extensionSettings || extension_settings;
    if (root?.[extensionName] && typeof root[extensionName] === 'object') return root[extensionName];
  } catch {}
  try {
    if (extension_settings?.[extensionName] && typeof extension_settings[extensionName] === 'object') {
      return extension_settings[extensionName];
    }
  } catch {}
  return defaultSettings;
}

/**
 * Automatic, read-only calendar status. It refreshes on ready, chat switch,
 * panel open and the public Gouhua calendar event. It never writes metadata,
 * never invents a fallback calendar and never toasts on background refreshes.
 */
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

// ===== 1.4.8 结构档案保存 / 主面板 / Quick Reply =====
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
  if (merged.rejected) {
    return { ok: false, warnings: merged.warnings };
  }
  Object.assign(settings, merged.fields);
  try {
    saveSettings();
  } catch (error) {
    return { ok: false, warnings: [`结构档案保存失败：${error.message}`] };
  }
  return { ok: true, warnings: merged.warnings };
}

function setQrStatus(text, isError = false) {
  const element = document.getElementById('rl-qr-status-text');
  if (element) {
    element.textContent = text || '';
    element.classList.toggle('rl-calendar-error', !!isError);
  }
}

function readPersistedQuickReplyState() {
  try { return normalizeQuickReplyInstallState(getCurrentSettingsObject().quickReplyInstall); }
  catch { return defaultQuickReplyInstallState(); }
}

function hasSettingsNamespace() {
  try {
    const root = __getCtx()?.extensionSettings || extension_settings;
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
      const ctx = __getCtx();
      const acc = ctx?.accountStorage;
      if (acc?.setItem) acc.setItem('response_linter_settings', JSON.stringify(settings));
    } catch {}
    const saveFn = __getCtx()?.saveSettingsDebounced || saveSettingsDebounced;
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
    try { window.toastr?.info?.('已打开修复预览，请确认或取消。', '响应检查器'); } catch {}
    return { success: true, pendingConfirmation: true };
  }
  if (result?.success) {
    try { window.toastr?.success?.('修复已应用', '响应检查器'); } catch {}
    return { success: true };
  }
  return { success: false, reason: result?.reason || '修复失败' };
}

function ensureQuickReplyCommand() {
  if (quickReplyCommand?.ok) return quickReplyCommand;
  if (quickReplyCommand?.state === 'collision') return quickReplyCommand;
  const ctx = __getCtx() || {};
  quickReplyCommand = registerQuickReplyCommand({
    ctx,
    runRepair: runQrRepairAction,
    toastr: window.toastr,
  });
  if (!quickReplyCommand.ok && quickReplyCommand.state === 'collision') {
    setQrStatus(quickReplyCommand.reason, true);
    if (!qrCollisionNotified) {
      qrCollisionNotified = true;
      try { window.toastr?.warning?.(escapeHtml(quickReplyCommand.reason), '响应检查器', { escapeHtml: false, timeOut: 8000 }); } catch {}
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
    notify: (message, isError) => {
      setQrStatus(message, isError);
    },
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

function openMainSettingsPanel() {
  if (!mainPanel) return;
  try { structureProfileUI.onPanelOpen(); } catch {}
  try { refreshCalendarStatus(); } catch {}
  try { refreshQuickReplyStatus(); } catch {}
  try { UIState.updateStatistics?.(); UIState.updateStatusIndicator?.(); } catch {}
  mainPanel.open();
}

function setupLaunchers(settingsHtml) {
  mainPanel = setupMainPanel({
    settingsHtml,
    onOpen: () => {
      try { structureProfileUI.onPanelOpen(); } catch {}
      try { refreshCalendarStatus(); } catch {}
      try { refreshQuickReplyStatus(); } catch {}
      try { UIState.updateStatistics?.(); UIState.updateStatusIndicator?.(); } catch {}
    },
    onQrRestore: () => { void restoreQuickReplyButton(); },
    onStatusText: () => '响应检查器',
  });
  structureProfileUI.initialize({
    getSettings: getCurrentSettingsObject,
    persistProfiles: persistStructureProfiles,
    notify: (text, isError) => {
      if (window.toastr && isError) window.toastr.warning?.(escapeHtml(text), '响应检查器', { escapeHtml: false });
    },
  });
  const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
  if (target?.length) installDrawerLauncher(target[0]);
  installWandLauncher({ attempts: 12, delayMs: 250 });
}

// 设置管理
async function loadSettings() {
  // 延迟初始化：此处不写入默认值，避免在宿主尚未把持久化设置加载完成前覆盖用户数据

  // 通过 getContext() 取最新设置根，避免被窗口级对象覆盖
  const ctx = __getCtx();
  const settingsRoot = ctx?.extensionSettings || extension_settings;
  const hasKey = Object.prototype.hasOwnProperty.call(settingsRoot || {}, extensionName);
  try { console.info('[Response Linter] loadSettings(begin): hasKey=', hasKey, 'keys=', settingsRoot ? Object.keys(settingsRoot).length : 'null'); } catch {}

  // 从 accountStorage 读取备份（若存在），避免版本更新或时序覆盖导致丢失
  let backup = null;
  try {
    const acc = ctx?.accountStorage;
    const backupJson = acc?.getItem?.('response_linter_settings');
    if (backupJson) backup = JSON.parse(backupJson);
  } catch (e) { console.warn('[Response Linter] 读取 accountStorage 备份失败', e); }

  // 仅在 hasKey 时才从 settingsRoot 读取/回写，避免在宿主未就绪时创建命名空间
  let settings = hasKey ? (settingsRoot[extensionName] || null) : null;
  if (!settings && backup) {
    settings = backup;
    if (hasKey && !settingsRoot[extensionName]) {
      settingsRoot[extensionName] = settings;
      console.info('[Response Linter] 从 accountStorage 备份恢复设置');
    }
  }

  // 兜底：仍不存在则使用默认（仅用于渲染UI与后端初始化，不回写到 settingsRoot 当 hasKey=false）
  if (!settings) {
    settings = JSON.parse(JSON.stringify(defaultSettings));
  }

  // 旧版设置自动派生版本化结构档案；不依赖用户点击保存，也不重置任何既有字段。
  const profileMigration = migrateStructureProfileSettings(settings);
  if (Object.keys(profileMigration.fields).length) Object.assign(settings, profileMigration.fields);

  // 仅当宿主已有我们的命名空间时才镜像到 window.extension_settings/ctx，避免早期写入导致“默认值落盘”
  if (hasKey) {
    try { settingsRoot[extensionName] = settings; } catch (e) {}
    try { if (window.extension_settings) window.extension_settings[extensionName] = settings; } catch (e) {}
  }

  // 更新UI状态（引用相同 settings 对象，避免两个源产生分叉）
  UIState.isExtensionEnabled = !!settings.enabled;
  UIState.isAutoFixEnabled = !!settings.autoFix;
  UIState.rules = Array.isArray(settings.rules) ? settings.rules : [];
  try { console.info('[Response Linter] loadSettings(end): rules=', UIState.rules.length, 'enabled=', UIState.isExtensionEnabled); } catch {}

  // 更新UI控件
  $('#rl-enabled').prop('checked', settings.enabled);
  $('#rl-auto-fix').prop('checked', settings.autoFix);
  $('#rl-default-auto-fix-action').val(settings.defaultAutoFixAction || 'apply');
  $('#rl-notification-duration').val(settings.notifications.duration);
  $('#rl-duration-display').text(settings.notifications.duration + '秒');
  $('#rl-show-success').prop('checked', settings.notifications.showSuccess);

  // 结构清理与历法设置（缺失字段按默认关闭，不重置旧规则）
  const features = getFeatureSettings(settings);
  $('#rl-remove-leaked-reasoning').prop('checked', features.removeLeakedReasoning);
  $('#rl-repair-sdc-boundary').prop('checked', features.repairSdcBoundary);
  $('#rl-repair-details-order').prop('checked', features.repairDetailsOrder);
  $('#rl-details-monologue-keyword').val(features.detailsMonologueKeyword);
  $('#rl-details-choices-keyword').val(features.detailsChoicesKeyword);
  $('#rl-sdc-calendar-source').val(features.sdcCalendarSource);
  $('#rl-sdc-custom-calendar').val(customJsonForTextarea(features.sdcCustomCalendarJson));
  if (features.sdcCalendarSource === 'custom') {
    const seeded = seedCustomCalendarDraft($('#rl-sdc-custom-calendar').val(), features.sdcCustomCalendarJson);
    if (seeded.seeded) {
      $('#rl-sdc-custom-calendar').val(seeded.text);
      // 仅为当前会话/后续保存提供有效草稿；不在此处主动落盘。
      settings.sdcCustomCalendarJson = seeded.text.trim();
    }
  }
  $('#rl-sdc-advance-minutes').val(features.sdcAdvanceMinutes);
  updateCalendarCustomVisibility();
  try { structureProfileUI.refreshFromSettings({ preserveDraft: false }); } catch (e) { console.warn('[Response Linter] profile UI refresh failed', e); }
  try { ensureCalendarWatch(); } catch {}
  try { refreshCalendarStatus(); } catch {}

  // 渲染规则并更新状态
  if (window.RulesManager?.renderRulesList) window.RulesManager.renderRulesList();
  if (window.UIState?.updateStatistics) window.UIState.updateStatistics();
  if (window.UIState?.loadGuideState) window.UIState.loadGuideState(); // 加载指引展开状态

  // 初始化/更新后端系统（若后端加载失败则跳过，UI仍可显示）
  try {
    if (!backendController) throw new Error('backendController未就绪');

    // 若已初始化，则仅更新设置；否则执行初始化
    if (backendController.isInitialized) {
      backendController.updateSettings(settings);
    } else {
      backendController.initialize(settings);
    }
    window.backendController = backendController;
  } catch (e) {
    console.warn('[Response Linter] 后端未就绪，UI先行加载。某些功能不可用。', e);
  }
  console.info('[Response Linter] loadSettings() 已应用设置到后端 (initialized:', backendController?.isInitialized, ')');

  // 确保消息监听激活：若启用且有活跃规则则正常启动；否则启动被动监听以便诊断
  try {
    if (backendController) {
      const hasActiveRules = (settings.rules||[]).some(r=>r.enabled);
      if (settings.enabled && hasActiveRules) {
        backendController.start?.();
      } else if (!backendController.isRunning) {
        console.info('[Response Linter] 启动被动监听（诊断模式）：扩展未启用或无活跃规则，验证不会执行');
        backendController.start?.();
      }
    }
  } catch (e) { console.warn('[Response Linter] 后端启动回退失败:', e); }

  // 自动迁移写回：用户不需要点击“保存”。只在宿主已有命名空间时写，避免早期默认值落盘。
  if (profileMigration.migrated && hasKey) {
    try {
      settingsRoot[extensionName] = settings;
      if (window.extension_settings) window.extension_settings[extensionName] = settings;
      saveSettings();
      console.info('[Response Linter] 结构配置档案已自动迁移并保存');
    } catch (e) {
      console.warn('[Response Linter] 结构配置档案自动迁移保存失败:', e);
    }
  }
}

function saveSettings() {
  const ctx = __getCtx();
  const settingsRoot = ctx?.extensionSettings || extension_settings;
  const hasKey = Object.prototype.hasOwnProperty.call(settingsRoot || {}, extensionName);
  const before = settingsRoot[extensionName];
  try { console.info('[Response Linter] saveSettings(begin): hasKey=', hasKey, 'rulesBefore=', Array.isArray(before?.rules)? before.rules.length : 'n/a'); } catch {}

  // 若宿主尚未创建我们的命名空间，直接延迟，不进行任何写入或保存
  if (!hasKey) {
    console.info('[Response Linter] saveSettings() deferred: extensionSettings not ready for our namespace');
    return;
  }

  settingsRoot[extensionName] = settingsRoot[extensionName] || window.extension_settings?.[extensionName] || JSON.parse(JSON.stringify(defaultSettings));
  const settings = settingsRoot[extensionName];

  settings.enabled = !!UIState.isExtensionEnabled;
  settings.autoFix = !!UIState.isAutoFixEnabled;
  settings.defaultAutoFixAction = $('#rl-default-auto-fix-action').val() || 'apply';
  settings.notifications = settings.notifications || { duration: 5, showSuccess: true };
  settings.notifications.duration = parseInt($('#rl-notification-duration').val());
  settings.notifications.showSuccess = $('#rl-show-success').prop('checked');
  settings.rules = Array.isArray(UIState.rules) ? UIState.rules : (settings.rules || []);

  // 结构清理开关、折叠块关键词与历法配置：独立保存；非法 JSON/参数不覆盖上一次有效配置。
  const merged = mergeFeatureSettings(settings, {
    removeLeakedReasoning: $('#rl-remove-leaked-reasoning').prop('checked') === true,
    repairSdcBoundary: $('#rl-repair-sdc-boundary').prop('checked') === true,
    repairDetailsOrder: $('#rl-repair-details-order').prop('checked') === true,
    detailsMonologueKeyword: $('#rl-details-monologue-keyword').val(),
    detailsChoicesKeyword: $('#rl-details-choices-keyword').val(),
    sdcCalendarSource: $('#rl-sdc-calendar-source').val() || FEATURE_DEFAULTS.sdcCalendarSource,
    sdcCustomCalendarJson: $('#rl-sdc-custom-calendar').val() || '',
    sdcAdvanceMinutes: $('#rl-sdc-advance-minutes').val(),
  });
  Object.assign(settings, merged.fields);
  if (!Array.isArray(settings.structureProfiles) || !settings.structureProfiles.length) {
    Object.assign(settings, migrateStructureProfileSettings(settings).fields);
  }
  $('#rl-sdc-calendar-source').val(settings.sdcCalendarSource);
  $('#rl-details-monologue-keyword').val(settings.detailsMonologueKeyword);
  $('#rl-details-choices-keyword').val(settings.detailsChoicesKeyword);
  $('#rl-sdc-advance-minutes').val(settings.sdcAdvanceMinutes);
  updateCalendarCustomVisibility();
  for (const warning of merged.warnings) {
    if (window.toastr) window.toastr.warning(escapeHtml(warning), '响应检查器', { timeOut: 6000, escapeHtml: false });
  }

  try { refreshCalendarStatus(); } catch {}

  // 同步更新后端设置（后端可能尚未就绪）
  try {
    if (!backendController) throw new Error('backendController未就绪');
    backendController.updateSettings(settings);
    console.info('[Response Linter] updateSettings() 已提交设置到后端');
  } catch (e) {
    console.warn('[Response Linter] 后端未就绪，暂不更新后端设置');
  }

  // 镜像到 window.extension_settings，避免界面其它地方读取旧引用
  try { if (window.extension_settings) window.extension_settings[extensionName] = settings; } catch (e) {}

  // 设置保存后立即刷新手动修复/撤销按钮；按钮状态从当前 getContext() 重新读取。
  try { UIState.updateStatistics(); UIState.updateStatusIndicator(); } catch (e) {}

  // 额外：写入 accountStorage 备份，保证跨版本/覆盖安全
  try {
    const acc = ctx?.accountStorage;
    if (acc?.setItem) acc.setItem('response_linter_settings', JSON.stringify(settings));
  } catch (e) { console.warn('[Response Linter] 写入 accountStorage 备份失败', e); }

  const saveFn = ctx?.saveSettingsDebounced || saveSettingsDebounced;
  if (typeof saveFn === 'function') { saveFn(); console.info('[Response Linter] saveSettingsDebounced() 已触发'); }
  // 已移除：向 SillyTavern/data/files（/user/files）写入备份；统一依赖 extensionSettings + saveSettingsDebounced() 持久化
}

// 后端事件处理器

// ===== SillyTavern/data/files 备份与恢复 =====
// 已移除：data/files 备份相关方法 persistSettingsToDataFile 与 tryLoadSettingsFromDataFile（改为仅使用 extensionSettings 持久化）

function setupBackendEventHandlers() {
  // 监听验证失败事件
  document.addEventListener('responseLinter.validationFailed', event => {
    const { result } = event.detail;
    ValidationFunctions.showDetailedValidationNotification(result);
    UIState.updateStatistics();
  });

  // 监听验证通过事件
  document.addEventListener('responseLinter.validationPassed', event => {
    if (extension_settings[extensionName].notifications.showSuccess) {
      toastr.success('消息验证通过', '响应检查器', { timeOut: 2000 });
    }
    UIState.updateStatistics();
  });

  // ============ 修复相关事件监听器 ============

  // 监听修复确认请求事件
  document.addEventListener('responseLinter.confirmationRequired', event => {
    const { messageId, originalContent, newContent, strategy, warnings, dialogContent } = event.detail;
    // 异步调用修复确认对话框（不需要等待）
    showFixConfirmationDialog(messageId, originalContent, newContent, strategy, warnings);
  });

  document.addEventListener('responseLinter.fixStatisticsChanged', () => UIState.updateStatistics());

  // 监听修复应用成功事件
  document.addEventListener('responseLinter.fixApplied', event => {
    const { task, fixResult } = event.detail;
    const warnings = task?.warnings || fixResult?.metadata?.warnings || [];
    if (warnings.length) toastr.warning(joinWarningToasts(warnings), '响应检查器', { timeOut: 8000, escapeHtml: false });
    toastr.success(`修复成功应用 - ${task.fixStrategy}`, '响应检查器');
    UIState.updateStatistics();
  });

  // 结构清理警告（例如未闭合推理块无法安全删除）
  document.addEventListener('responseLinter.fixWarning', event => {
    const warnings = event.detail?.warnings || [];
    if (warnings.length) toastr.warning(joinWarningToasts(warnings), '响应检查器', { timeOut: 8000, escapeHtml: false });
  });

  // 监听修复确认事件
  document.addEventListener('responseLinter.fixConfirmed', event => {
    const { messageId, warnings } = event.detail;
    if (Array.isArray(warnings) && warnings.length) {
      toastr.warning(joinWarningToasts(warnings), '响应检查器', { timeOut: 8000, escapeHtml: false });
    }
    toastr.success('修复已确认应用', '响应检查器');
    UIState.updateStatistics();
  });

  // 监听修复取消事件
  document.addEventListener('responseLinter.fixCancelled', event => {
    const { messageId } = event.detail;
    toastr.info('修复操作已取消', '响应检查器');
    UIState.updateStatistics();
  });

  // 监听修复撤销事件
  document.addEventListener('responseLinter.fixUndone', event => {
    const { messageId, steps } = event.detail;
    toastr.info(`已撤销 ${steps} 步修复操作`, '响应检查器');
    UIState.updateStatistics();
  });

  // 监听重新验证通过事件
  document.addEventListener('responseLinter.revalidationPassed', event => {
    const { messageId } = event.detail;
    toastr.success('修复后验证通过', '响应检查器', { timeOut: 2000 });
  });

  // 监听重新验证失败事件
  document.addEventListener('responseLinter.revalidationFailed', event => {
    const { messageId } = event.detail;
    toastr.warning('修复后仍有验证问题', '响应检查器');
  });

  // 监听后端状态变化
  document.addEventListener('responseLinter.backendStarted', () => {
    UIState.updateStatusIndicator();
    console.log('后端服务已启动');
  });

  document.addEventListener('responseLinter.backendStopped', () => {
    UIState.updateStatusIndicator();
    console.log('后端服务已停止');
  });
}

// 事件处理器设置
function setupEventHandlers() {
  // Child modals close before the shared main panel. Capture phase avoids the
  // parent panel also closing on the same Escape key.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    try {
      const ruleEditorVisible = $('#rl-rule-editor-modal').is(':visible');
      const wizardVisible = $('#rl-config-wizard-modal').is(':visible');
      if (ruleEditorVisible) {
        event.preventDefault();
        event.stopPropagation();
        window.RuleEditor?.hideModal?.();
      } else if (wizardVisible) {
        event.preventDefault();
        event.stopPropagation();
        window.ConfigWizard?.hide?.();
      }
    } catch {}
  }, true);

  // 主要控件
  $('#rl-enabled').on('change', function () {
    UIState.isExtensionEnabled = $(this).prop('checked');
    UIState.updateStatusIndicator();
    saveSettings();
    UIState.updateStatistics();

    const status = UIState.isExtensionEnabled ? '已启用' : '已禁用';
    toastr.info(`响应检查器${status}`, '响应检查器');
  });

  $('#rl-auto-fix').on('change', function () {
    UIState.isAutoFixEnabled = $(this).prop('checked');
    saveSettings();
  });

  // 通知设置
  $('#rl-notification-duration').on('input', function () {
    const value = $(this).val();
    $('#rl-duration-display').text(value + '秒');
    saveSettings();
  });

  // 自动修复默认行为（独立绑定）
  $('#rl-default-auto-fix-action').on('change', saveSettings);

  $('#rl-show-success').on('change', saveSettings);

  // ===== 结构清理 / SDC 历法控件 =====
  $('#rl-remove-leaked-reasoning').on('change', function () {
    saveSettings();
    if (window.toastr) {
      window.toastr.info($(this).prop('checked') ? '已启用泄漏推理清理（仅删除完整或边界明确的推理块）' : '已关闭泄漏推理清理', '响应检查器', { timeOut: 3000 });
    }
  });

  $('#rl-repair-sdc-boundary').on('change', function () {
    saveSettings();
    if (window.toastr) {
      window.toastr.info($(this).prop('checked') ? '已启用 SDC/正文边界修复（使用下方历法来源）' : '已关闭 SDC/正文边界修复', '响应检查器', { timeOut: 3000 });
    }
  });

  $('#rl-repair-details-order').on('change', function () {
    saveSettings();
    if (window.toastr) {
      window.toastr.info($(this).prop('checked')
        ? '已启用正文外折叠块顺序与配对修复（只交换两个目标块）'
        : '已关闭正文外折叠块顺序与配对修复', '响应检查器', { timeOut: 3000 });
    }
  });

  $('#rl-details-monologue-keyword, #rl-details-choices-keyword').on('change', saveSettings);

  $('#rl-sdc-calendar-source').on('change', function () {
    if ($(this).val() === 'custom') {
      const saved = getFeatureSettings((__getCtx()?.extensionSettings || extension_settings)?.[extensionName] || {});
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

  $('#rl-sdc-calendar-check').on('click', function () {
    const result = refreshCalendarStatus();
    if (!window.toastr) return;
    if (result.ok) window.toastr.success(`历法可用：${result.sourceLabel}`, '响应检查器', { timeOut: 3000 });
    else window.toastr.warning(`历法不可用：${result.error}`, '响应检查器', { timeOut: 6000 });
  });

  $('#rl-sdc-export-config').on('click', function () {
    try {
      const currentSettings = getCurrentSettingsObject();
      const settings = getFeatureSettings(currentSettings);
      const profileCollection = readStructureProfiles(currentSettings);
      const exportSource = $('#rl-sdc-calendar-source').val() || settings.sdcCalendarSource;
      const localCustomText = $('#rl-sdc-custom-calendar').val() || settings.sdcCustomCalendarJson;
      const payload = createStructureSettingsExport({
        ...currentSettings,
        structureProfilesVersion: profileCollection.version,
        structureProfiles: profileCollection.profiles,
        structureProfileId: profileCollection.activeProfileId,
        removeLeakedReasoning: $('#rl-remove-leaked-reasoning').prop('checked') === true,
        repairSdcBoundary: $('#rl-repair-sdc-boundary').prop('checked') === true,
        repairDetailsOrder: $('#rl-repair-details-order').prop('checked') === true,
        detailsMonologueKeyword: $('#rl-details-monologue-keyword').val() || settings.detailsMonologueKeyword,
        detailsChoicesKeyword: $('#rl-details-choices-keyword').val() || settings.detailsChoicesKeyword,
        sdcCalendarSource: exportSource,
        sdcCustomCalendarJson: localCustomText,
        sdcAdvanceMinutes: Number($('#rl-sdc-advance-minutes').val()) || DEFAULT_ADVANCE_MINUTES,
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'response-linter-structure-settings.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      window.toastr?.success('结构清理/历法/折叠块配置已导出', '响应检查器');
    } catch (error) {
      console.error('导出结构清理配置失败:', error);
      window.toastr?.error('导出配置失败', '响应检查器');
    }
  });

  // A file input must stay attached while the native picker is open. A
  // detached input still fires a filechooser event, but the browser automation
  // backend then has no attached node to receive the selected file. Reuse one
  // hidden, offscreen input instead of creating a detached node per click.
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

  $('#rl-sdc-import-config').on('click', function () {
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
            const current = getFeatureSettings(currentSettings);
            const imported = importStructureSettingsText(e.target.result, currentSettings);
            if (!imported.ok) throw new Error(imported.error);
            const next = imported.settings;
            $('#rl-sdc-custom-calendar').val(customJsonForTextarea(next.sdcCustomCalendarJson));
            $('#rl-sdc-calendar-source').val(next.sdcCalendarSource);
            $('#rl-remove-leaked-reasoning').prop('checked', next.removeLeakedReasoning);
            $('#rl-repair-sdc-boundary').prop('checked', next.repairSdcBoundary);
            $('#rl-repair-details-order').prop('checked', next.repairDetailsOrder);
            $('#rl-details-monologue-keyword').val(next.detailsMonologueKeyword);
            $('#rl-details-choices-keyword').val(next.detailsChoicesKeyword);
            $('#rl-sdc-advance-minutes').val(next.sdcAdvanceMinutes);
            Object.assign(currentSettings, {
              structureProfilesVersion: next.structureProfilesVersion,
              structureProfiles: next.structureProfiles,
              structureProfileId: next.structureProfileId,
            });
            try { structureProfileUI.refreshFromSettings({ preserveDraft: false }); } catch {}
            updateCalendarCustomVisibility();
            saveSettings();
            window.toastr?.success('结构档案/历法/折叠块配置已导入并保存', '响应检查器');
          } catch (error) {
            console.error('导入结构清理配置失败:', error);
            window.toastr?.error(formatErrorForToast('导入失败：', error), '响应检查器', { timeOut: 6000, escapeHtml: false });
          }
        };
        reader.readAsText(file);
      };
      input.click();
    } catch (error) {
      console.error('导入结构清理配置失败:', error);
      window.toastr?.error('导入配置失败', '响应检查器');
    }
  });

  // 安全加载 ConfigWizard（若尚未初始化，进行懒加载）
  async function ensureConfigWizard() {
    try {
      if (!window.ConfigWizard) {
        const { ConfigWizardUI } = await import('./presentation/modules/config-wizard-ui.js');
        await ConfigWizardUI.initialize();
      }
    } catch (e) {
      console.error('加载配置向导模块失败:', e);
    }
    return window.ConfigWizard;
  }

  // 安全加载 RuleEditor（若尚未初始化，进行懒加载）
  async function ensureRuleEditor() {
    try {
      if (!window.RuleEditor) {
        const { RuleEditorUI } = await import('./presentation/modules/rule-editor-ui.js');
        await RuleEditorUI.initialize();
      }
    } catch (e) {
      console.error('加载规则编辑器模块失败:', e);
    }
    return window.RuleEditor;
  }

  // 安全加载 RulesManager（若尚未初始化，进行懒加载）
  async function ensureRulesManager() {
    try {
      if (!window.RulesManager) {
        const { RulesManagerUI } = await import('./presentation/modules/rules-manager-ui.js');
        await RulesManagerUI.initialize();
      }
    } catch (e) {
      console.error('加载规则管理器模块失败:', e);
    }
    return window.RulesManager;
  }

  // 规则管理按钮（使用懒加载确保可用）
  $('#rl-add-rule').on('click', async () => (await ensureRuleEditor())?.showAddModal());
  $('#rl-demo-validation').on('click', async () => (await ensureRulesManager()) && ValidationFunctions?.triggerManualValidation?.());
  $('#rl-import-rules').on('click', async () => (await ensureRulesManager())?.importRules?.());
  $('#rl-export-rules').on('click', async () => (await ensureRulesManager())?.exportRules?.());

  // 模板按钮事件（确保RulesManager存在）
  $('#rl-template-thinking').on('click', async () => (await ensureRulesManager())?.addTemplate('thinking'));
  $('#rl-template-code').on('click', async () => (await ensureRulesManager())?.addTemplate('code'));
  $('#rl-template-qa').on('click', async () => (await ensureRulesManager())?.addTemplate('qa'));

  // 诊断按钮：输出状态并主动尝试启动监听
  $('#rl-diagnostics').on('click', async () => {
    try {
      const ctx = __getCtx();
      const status = {
        ctxReady: !!ctx,
        hasEventSource: !!ctx?.eventSource,
        hasEventTypes: !!(ctx?.eventTypes || ctx?.event_types),
        backend: backendController?.getStatus?.() || null,
      };
      console.info('[Response Linter][诊断] 当前状态:', status);
      if (backendController && !backendController.isRunning) {
        console.info('[Response Linter][诊断] 尝试启动后端监听...');
        backendController.start?.();

  // 诊断：输出 getContext 可用项
  try {
    const ctx = __getCtx();
    console.info('[Response Linter][诊断] ctx 快照:', {
      keys: ctx ? Object.keys(ctx).slice(0, 12) : null,
      typeofCtx: typeof ctx,
      hasEventSource: !!ctx?.eventSource,
      hasEventTypes: !!(ctx?.eventTypes || ctx?.event_types),
      hasRenderTemplate: !!ctx?.renderExtensionTemplateAsync,
    });
  } catch {}

      }
      toastr?.info?.('诊断信息已输出到控制台', '响应检查器');
    } catch (e) {
      console.error('[Response Linter][诊断] 失败:', e);
    }
  });

  // 配置向导事件（懒加载，确保模块已初始化）
  $('#rl-config-wizard').on('click', async () => { const CW = await ensureConfigWizard(); if (CW && CW.show) CW.show(); });
  $('#rl-close-wizard, #rl-wizard-cancel').on('click', async () => { const CW = await ensureConfigWizard(); if (CW && CW.hide) CW.hide(); });
  $('#rl-wizard-prev').on('click', async () => { const CW = await ensureConfigWizard(); if (CW && CW.prev) CW.prev(); });
  $('#rl-wizard-next').on('click', async () => { const CW = await ensureConfigWizard(); if (CW && CW.next) CW.next(); });
  $('#rl-wizard-finish').on('click', async () => { const CW = await ensureConfigWizard(); if (CW && CW.finish) CW.finish(); });
  $('#rl-wizard-test-btn').on('click', async () => { const CW = await ensureConfigWizard(); if (CW && CW.testRule) CW.testRule(); });

  // 向导模式选择事件
  $(document).on('click', '.rl-wizard-option', async function () {
    $('.rl-wizard-option').removeClass('selected');
    $(this).addClass('selected');
    const CW = await ensureConfigWizard();
    if (CW) CW.selectedMode = $(this).data('mode');
  });

  // 使用指引展开/收起按钮事件
  $('#rl-toggle-guide').on('click', () => UIState.toggleGuide());

  // 统计
  $('#rl-reset-stats').on('click', function () {
    try { if (backendController) backendController.resetStatistics(); } catch {}
    const settings = extension_settings[extensionName];
    settings.statistics = {
      validations: 0,
      fixes: 0,
      fixAttempts: 0,
      cancellations: 0,
      successRate: 100,
    };
    UIState.updateStatistics();
    saveSettings();
    toastr.info('统计已重置', '响应检查器');
  });

  // 手动修复功能
  $('#rl-manual-fix').on('click', async function () {
    const button = $(this);
    const originalText = button.text();

    try {
      button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 修复中...');

      // 获取最新AI消息的ID
      const latestMessageId = UIState.getLatestAIMessageId();
      if (!latestMessageId) {
        toastr.warning('没有找到可修复的AI消息', '响应检查器');
        return;
      }

      // 调用后端修复API（后端可能尚未就绪）
      let result = { success: false, reason: '后端未就绪' };
      if (backendController?.triggerManualFix) {
        result = await backendController.triggerManualFix(latestMessageId);
      }

      if (result.success) {
        toastr.success('修复已应用', '响应检查器');
        UIState.updateStatistics();
      } else if (!result.metadata?.requiresConfirmation) {
        toastr.error(escapeHtml(result.reason || '修复失败'), '响应检查器', { escapeHtml: false });
      }
      if (Array.isArray(result.warnings) && result.warnings.length) {
        toastr.warning(joinWarningToasts(result.warnings), '响应检查器', { timeOut: 8000, escapeHtml: false });
      }
    } catch (error) {
      console.error('手动修复失败:', error);
      toastr.error('修复过程出错', '响应检查器');
    } finally {
      button.html(originalText);
      UIState.updateStatistics();
    }
  });

  $('#rl-undo-fix').on('click', async function () {
    $(this).prop('disabled', true);
    try {
      const id = UIState.getLatestAIMessageId();
      if (id === null) return;
      const result = await backendController.undoFix(id);
      if (!result.success) toastr.warning(result.metadata?.reason || '撤销失败', '响应检查器');
    } finally { UIState.updateStatistics(); }
  });

  // 规则编辑器模态框事件
  $('#rl-close-editor, #rl-cancel-rule').on('click', () => RuleEditor.hideModal());
  $('#rl-save-rule').on('click', () => RuleEditor.saveRule());

  // 规则编辑器表单事件
  $('#rl-add-content').on('click', () => RuleEditor.addContentTag());
  $('#rl-new-content').on('keypress', function (e) {
    if (e.which === 13) {
      e.preventDefault();
      RuleEditor.addContentTag();
    }
  });

  $('#rl-rule-strategy').on('change', () => RuleEditor.toggleCustomStrategy());

  // 规则项目的动态事件处理器
  $(document).on('change', '.rl-rule-enabled', function () {
    const ruleId = $(this).closest('.rl-rule-item').data('rule-id');
    const enabled = $(this).prop('checked');
    window.RulesManager?.toggleRule?.(ruleId, enabled);
  });

  $(document).on('click', '.rl-edit-rule', function () {
    const ruleId = $(this).closest('.rl-rule-item').data('rule-id');
    RuleEditor.showEditModal(ruleId);
  });

  $(document).on('click', '.rl-delete-rule', function () {
    const ruleId = $(this).closest('.rl-rule-item').data('rule-id');
    const rule = UIState.rules.find(r => r.id === ruleId);

    if (confirm(`确定要删除规则"${rule.name}"吗？`)) {
      window.RulesManager?.deleteRule?.(ruleId);
    }
  });

  // 保留旧标签系统的兼容性
  $(document).on('click', '.rl-remove-tag', function () {
    const content = $(this).data('content');
    RuleEditor.removeContentTag(content);
  });

  // 点击外部关闭模态框
  $('#rl-rule-editor-modal').on('click', function (e) {
    if (e.target === this) {
      RuleEditor.hideModal();
    }
  });

  // 配置向导模态框事件：点击遮罩弹确认再关闭（默认行为）
  $('#rl-config-wizard-modal').on('click', async function (e) {
    if (e.target === this) {
      if (window.confirm('关闭配置向导？当前进度将不会保存。')) {
        const CW = await ensureConfigWizard();
        if (CW) CW.hide();
      }
    }
  });
}

// 扩展初始化
jQuery(async () => {
  let initializationMode = 'unknown';

    // 二次桥接：确保弹窗API在模板加载后可用（部分环境下早期桥接可能失败）
    try {
      const ctx2 = __getCtx();
      const popup2 = (ctx2 && ctx2.callGenericPopup) ? ctx2.callGenericPopup : (window.callGenericPopup || callGenericPopup);
      if (popup2) window.callGenericPopup = popup2;
    } catch {}

  let moduleInitSuccess = false;

  try {
    console.log('🚀 Response Linter扩展开始初始化...');
    console.info('[Response Linter] begin template load', { extensionFolderPath });

    // 🔒 核心UI注册逻辑 - 绝对不能修改
    console.log('📂 加载HTML模板...');
    const ctx = __getCtx();
    let settingsHtml, editorHtml;
    // 计算相对扩展路径（传给 ST 的 renderExtensionTemplateAsync）
    const extensionNameBase = (() => {
      try {
        const m = extensionFolderPath.match(/\/scripts\/extensions\/(.+)$/);
        return m ? m[1] : 'third-party/Response-Linter';
      } catch { return 'third-party/Response-Linter'; }
    })();
    const templatesBase = `${extensionNameBase}/presentation/templates`;

    if (ctx && typeof ctx.renderExtensionTemplateAsync === 'function') {
      // 使用酒馆标准模板加载（必须传 scripts/extensions 下的相对路径）
      settingsHtml = await ctx.renderExtensionTemplateAsync(templatesBase, 'settings');
      editorHtml = await ctx.renderExtensionTemplateAsync(templatesBase, 'rule-editor');
    } else {
      // 回退到$.get，保证兼容性（这里可以使用绝对路径）
      settingsHtml = await $.get(`${extensionFolderPath}/presentation/templates/settings.html`);
      editorHtml = await $.get(`${extensionFolderPath}/presentation/templates/rule-editor.html`);
    }

    // 1.4.8: 主设置 UI 只有一个共享 DOM，位于专用可访问浮层；
    // 扩展抽屉只保留小启动器，wand 菜单再增加一个明确入口。
    $('body').append(editorHtml);
    setupLaunchers(settingsHtml);
    const $right = $('#extensions_settings2');
    const $left = $('#extensions_settings');
    const $target = $right.length ? $right : $left;
    if ($target && $target.length) {
      installDrawerLauncher($target[0]);
      console.info('[Response Linter] drawer launcher appended to', $target.attr('id') || 'unknown');
    } else {
      console.warn('[Response Linter] 未找到扩展设置面板容器，退回 body 启动器');
      installDrawerLauncher(document.body);
    }
    installWandLauncher({ attempts: 16, delayMs: 250 });
    console.log('✅ HTML模板加载完成');

    // 🆕 尝试模块化初始化
    try {
      console.log('🔧 尝试模块化初始化...');

      // 动态导入UI模块管理器
      const { UIModuleManager } = await import('./presentation/modules/ui-module-manager.js');

      // 尝试初始化模块
      moduleInitSuccess = await UIModuleManager.initialize();

      if (moduleInitSuccess) {
        console.log('🎉 模块化初始化成功！');
        initializationMode = 'modular';
      } else {
        console.log('⚠️ 模块化初始化失败，回退到兼容模式');
        initializationMode = 'fallback';
      }
    } catch (moduleError) {
      console.error('❌ 模块化初始化出错，回退到兼容模式:', moduleError);
      moduleInitSuccess = false;
      initializationMode = 'fallback';
    }

    // 🔄 兼容模式初始化（原有逻辑）
    if (!moduleInitSuccess) {
      console.log('🔧 使用兼容模式初始化...');

      // 设置事件处理器（原有逻辑）
      setupEventHandlers();
    console.info('[Response Linter] loadSettings()');
      setupBackendEventHandlers();

      console.log('✅ 兼容模式初始化完成');
    } else {
      // 模块化模式仍需要这些函数，但将来会移到模块中
      setupEventHandlers();
      setupBackendEventHandlers();
    }

    // 斜杠命令必须在 Quick Reply 安装之前注册；API 缺失时只在有界窗口内重试。
    startQuickReplySurface();
    try {
      const qctx = __getCtx();
      const qes = qctx?.eventSource || window.eventSource;
      const appReady = (qctx?.eventTypes || qctx?.event_types)?.APP_READY;
      if (qes && appReady && typeof qes.once === 'function') {
        qes.once(appReady, () => { startQuickReplySurface(); ensureCalendarWatch(); refreshCalendarStatus(); });
      }
    } catch {}
    // 面板打开时也执行一次有界检查（不注册永久轮询）。
    document.addEventListener('click', event => {
      if (event.target?.closest?.('#rl-open-main-panel, #rl-wand-button')) {
        if (qrAutoStopped) {
          qrAutoAttempts = 0;
          qrAutoStopped = false;
          scheduleQrAutoCheck(150);
        }
      }
    }, true);

    // 诊断详情弹窗：展示模块化初始化状态（时间戳 / 已加载模块 / 错误信息）
    async function showModuleInitDetails() {
      try {
        const mgr = window.ResponseLinterUIModuleManager;
        const status = mgr?.getInitializationStatus?.() || {};
        const modules = Array.isArray(status.modules) ? status.modules : [];
        const err = status.error;
        const ts = status.timestamp || new Date().toISOString();

        const details = `
          <div style="line-height:1.6">
            <p>已自动切换到 <strong>兼容模式</strong>（若模块化失败），功能仍可使用。</p>
            <p><strong>时间</strong>：${ts}</p>
            <p><strong>已加载模块</strong>：${modules.join(', ') || '（无）'}</p>
            <p><strong>错误信息</strong>：${(err && (err.message || String(err))) || '（未捕获错误）'}</p>
            <p style="margin-top:10px;color:#aaa">提示：按 F12 打开控制台可查看更完整的错误堆栈。</p>
          </div>
        `;

        const popup = (window.getContext && getContext().callGenericPopup)
          ? getContext().callGenericPopup
          : (window.callGenericPopup || (async (html) => alert('模块化加载失败，已切换到兼容模式。\n\n' + html.replace(/<[^>]+>/g, ''))));

        await popup?.(details, 'display', '模块化加载详情', { allowVerticalScrolling: true, wide: true });
      } catch (e) {
        console.error('显示模块化失败详情出错:', e);
      }
    }


    // 友好提示：若模块化失败，提示用户已自动切换到兼容模式，并提供详情入口
    if (!moduleInitSuccess) {
      try {
        const clickToShow = async () => {
          try { await showModuleInitDetails(); } catch (e) { console.warn('显示模块化失败详情弹窗失败', e); }
        };
        if (window.toastr) {
          window.toastr.info('模块化加载失败，已切换到兼容模式。点击查看详情', '响应检查器', {
            timeOut: 5000,
            closeButton: true,
            onclick: clickToShow,
          });
        } else {

          // 无 toastr 时降级
          console.warn('模块化加载失败，已切换到兼容模式');
        }
      } catch (e) { /* 忽略提示失败 */ }
    }


    // 🔧 加载设置：等待酒馆把 extension_settings 从服务器加载完成后再读取，避免我们用默认值覆盖后又被酒馆覆盖导致“设置重置”
    try {
      // 动态读取上下文，避免使用早期的“空”引用
      const getES = () => {
        const c = __getCtx();
        return {
          ctx: c,
          es: c?.eventSource || window.eventSource,
          et: c?.eventTypes || c?.event_types || window.event_types,
          settingsRoot: c?.extensionSettings || window.extension_settings,
        };
      };

      const tryImmediate = () => {
        const { settingsRoot } = getES();
        const hasOurExtSettings = !!(settingsRoot && Object.prototype.hasOwnProperty.call(settingsRoot, extensionName));
        if (hasOurExtSettings) {
          console.info('[Response Linter] our extension settings detected -> loadSettings');
          loadSettings();
          return true;
        }
        return false;
      };

      // 在设置完全加载后，若仍不存在我们的命名空间，则创建（优先用备份，否则默认），随后加载与保存一次
      let loadedHandled = false;
      const ensureNamespaceThenLoad = () => {
        if (loadedHandled) return; loadedHandled = true;
        try {
          const { ctx, settingsRoot } = getES();
          const hasKey = Object.prototype.hasOwnProperty.call(settingsRoot || {}, extensionName);
          if (!hasKey && settingsRoot) {
            let seed = null;
            try { const acc = ctx?.accountStorage; const js = acc?.getItem?.('response_linter_settings'); if (js) seed = JSON.parse(js); } catch {}
            if (!seed) seed = JSON.parse(JSON.stringify(defaultSettings));
            settingsRoot[extensionName] = seed;
            try { if (window.extension_settings) window.extension_settings[extensionName] = seed; } catch {}
            console.info('[Response Linter] created extension namespace after settings loaded');
            const saveFn = ctx?.saveSettingsDebounced || window.saveSettingsDebounced || saveSettingsDebounced; if (typeof saveFn === 'function') saveFn();
          }
        } catch (e) { console.warn('[Response Linter] failed to ensure namespace after settings loaded', e); }
        loadSettings();
      };

      // 监听事件：若当前尚不可用，则重试绑定
      let listenersBound = false;
      const tryBind = () => {
        const { es, et } = getES();
        if (es && et && !listenersBound) {
          console.info('[Response Linter] listeners attached for EXTENSION_SETTINGS_LOADED / SETTINGS_LOADED');
          es.once(et.EXTENSION_SETTINGS_LOADED, () => {
            console.info('[Response Linter] EXTENSION_SETTINGS_LOADED');
            ensureNamespaceThenLoad();
          });
          es.once(et.SETTINGS_LOADED, () => {
            console.info('[Response Linter] SETTINGS_LOADED (fallback)');
            ensureNamespaceThenLoad();
          });
          // 聊天切换后手动修复/撤销按钮需要立即反映新聊天的最新消息。
          if (et.CHAT_CHANGED && typeof es.on === 'function') {
            es.on(et.CHAT_CHANGED, () => {
              try { UIState.updateStatistics(); UIState.updateStatusIndicator(); } catch (e) {}
              try { refreshCalendarStatus(); } catch (e) {}
              try { refreshQuickReplyStatus(); } catch (e) {}
            });
          }
          listenersBound = true;
          return true;
        }
        return false;
      };

      // 首次尝试绑定；若失败，进行短期重试
      if (!tryBind()) {
        let attempts = 0;
        const retry = () => {
          if (tryBind()) return;
          if (++attempts > 20) { console.warn('[Response Linter] failed to attach settings listeners after retries'); return; }
          setTimeout(retry, 250);
        };
        setTimeout(retry, 250);
      }

      // 如已存在则立即加载一遍（不会影响后续一次性监听）
      tryImmediate();

      // 5秒兜底：避免早期写默认；仅记录
      setTimeout(() => {
        if (!tryImmediate()) {
          console.warn('[Response Linter] fallback delayed loadSettings() skipped: extension namespace not ready');
        }
      }, 5000);

      // 8秒保底：若此时仍无命名空间，则认为宿主已加载完设置但没有历史配置——创建并保存一次
      setTimeout(() => {
        const { ctx, settingsRoot } = getES();
        if (settingsRoot && !Object.prototype.hasOwnProperty.call(settingsRoot, extensionName)) {
          let seed = null; try { const acc = ctx?.accountStorage; const js = acc?.getItem?.('response_linter_settings'); if (js) seed = JSON.parse(js); } catch {}
          if (!seed) seed = JSON.parse(JSON.stringify(defaultSettings));
          settingsRoot[extensionName] = seed;
          try { if (window.extension_settings) window.extension_settings[extensionName] = seed; } catch {}
          console.warn('[Response Linter] late seeding extension namespace after 8s window');
          const saveFn = ctx?.saveSettingsDebounced || window.saveSettingsDebounced || saveSettingsDebounced; if (typeof saveFn === 'function') saveFn();
          loadSettings();
        }
      }, 8000);
    } catch (e) {
      console.warn('[Response Linter] settings load deferral failed, waiting for events');
      // 不再直接调用 loadSettings()，避免早期写默认
    }

    // 🎯 暴露全局访问点用于调试
    window.ResponseLinter = window.ResponseLinter || {};
    window.ResponseLinter.initializationMode = initializationMode;
    window.ResponseLinter.moduleInitSuccess = moduleInitSuccess;
    window.ResponseLinter.backendController = backendController;

    console.log(`🎉 Response Linter扩展初始化完成 [模式: ${initializationMode}]`);
  } catch (error) {
    console.error('💥 Response Linter扩展初始化失败:', error);
    toastr.error('响应检查器扩展加载失败', '扩展错误');

    // 记录错误信息用于调试
    window.ResponseLinter = window.ResponseLinter || {};
    window.ResponseLinter.initializationError = error;
    window.ResponseLinter.initializationMode = 'failed';
  }
});
