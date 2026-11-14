// Response Linter UI state for the streamlined 1.4.10 panel.
// Legacy rule lists, guides and statistics are intentionally absent.
import { getFreshContext } from '../../core/host-context.js';
import { hasEnabledFeature } from '../../core/repair-service.js';

function getCurrentExtensionSettings() {
  try {
    const root = getFreshContext()?.extensionSettings || window.extension_settings;
    return root?.['response-linter'] || {};
  } catch {
    return window.extension_settings?.['response-linter'] || {};
  }
}

export class UIStateManager {
  constructor() {
    this.isExtensionEnabled = false;
    this.isAutoFixEnabled = false;
  }

  static async initialize() {
    if (!window.ResponseLinter) window.ResponseLinter = {};
    const uiStateInstance = new UIStateManager();
    window.ResponseLinter.UIState = uiStateInstance;
    window.UIState = uiStateInstance;
  }

  updateStatusIndicator() {
    try {
      const indicator = $('#rl-status-indicator');
      const backendStatus = window.backendController
        ? window.backendController.getStatus()
        : { isRunning: false };
      const settings = getCurrentExtensionSettings();
      const hasFeature = hasEnabledFeature(settings);
      if (!this.isExtensionEnabled) {
        indicator.removeClass('active warning error').addClass('disabled');
        indicator.attr('title', '扩展已禁用');
      } else if (!hasFeature) {
        indicator.removeClass('active disabled error').addClass('warning');
        indicator.attr('title', '未启用任何回复修复功能');
      } else if (!backendStatus.isRunning) {
        indicator.removeClass('active disabled error').addClass('warning');
        indicator.attr('title', '自动修复未运行（手动修复仍可用）');
      } else {
        indicator.removeClass('disabled warning error').addClass('active');
        indicator.attr('title', '扩展运行中');
      }
    } catch (error) {
      console.error('更新状态指示器失败:', error);
    }
  }

  updateStatistics() {
    this.refreshManualFixButton();
  }

  /**
   * Refresh the two top-level repair actions from the current chat/settings.
   * Does not depend on a window settings mirror or any legacy rules.
   */
  refreshManualFixButton() {
    try {
      if (!window.backendController) return;
      const settings = getCurrentExtensionSettings();
      const enabled = Object.prototype.hasOwnProperty.call(settings, 'enabled')
        ? settings.enabled === true
        : this.isExtensionEnabled === true;
      this.isExtensionEnabled = enabled;
      const latestMessageId = this.getLatestAIMessageId();
      const canRepair = enabled && latestMessageId !== null && hasEnabledFeature(settings);
      $('#rl-manual-fix').prop('disabled', !canRepair);
      $('#rl-undo-fix').prop('disabled', latestMessageId === null || !window.backendController.canUndoFix(latestMessageId));
    } catch (error) {
      console.warn('刷新手动修复按钮失败:', error);
    }
  }

  getLatestAIMessageId() {
    try {
      const latest = window.backendController?.getLatestAIMessage();
      return latest ? String(latest.id) : null;
    } catch (error) {
      console.error('获取最新AI消息ID失败:', error);
      return null;
    }
  }
}

export function getUIState() {
  return window.UIState || window.ResponseLinter?.UIState;
}
