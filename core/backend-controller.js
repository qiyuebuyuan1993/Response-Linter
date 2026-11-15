// Response Linter 1.4.10 backend controller.
// Coordinates only the three structure-repair features and the shared repair
// coordinator. Generic validation rules are never initialized, validated or
// executed here, even if legacy settings/imports still contain them.
import { getFreshContext, findMessage, messageContent, messageSwipeId, captureAutoTarget, isCurrentAutoTarget, isStreamingContext } from './host-context.js';
import { buildRepairPlan, hasEnabledFeature } from './repair-service.js';
import { fixCoordinator } from './fix-coordinator.js';
import { messageHandler } from './message-handler.js';

const __getCtx = () => getFreshContext();

export class BackendController {
  constructor(extensionName) {
    this.extensionName = extensionName;
    this.isInitialized = false;
    this.isRunning = false;
    this.settings = null;
    this._autoPlanKeys = new Map(); // messageId -> last queued plan fingerprint
    this._warningKeys = new Map();
    this.statistics = {
      totalValidations: 0,
      failedValidations: 0,
      successfulFixes: 0,
      totalFixAttempts: 0,
      userCancellations: 0,
      lastActivity: null,
    };
    this._bindEventHandlers();
  }

  initialize(settings) {
    if (this.isInitialized) return;
    try {
      this.settings = settings || {};
      fixCoordinator.initialize({
        enabled: this.settings.enabled,
        autoFix: this.settings.autoFix || false,
        defaultAutoFixAction: this.settings.defaultAutoFixAction,
      });
      this.isInitialized = true;
      this._syncListening();
    } catch (error) {
      console.error('[Response Linter] 后端系统初始化失败:', error);
      this.isInitialized = false;
    }
  }

  start() {
    if (this.isRunning) return;
    try {
      messageHandler.startListening();
      this.isRunning = true;
      this._dispatchStatusEvent('backendStarted');
    } catch (error) {
      console.error('[Response Linter] 启动后端服务失败:', error);
      this.isRunning = false;
    }
  }

  stop() {
    if (!this.isRunning) return;
    try {
      messageHandler.stopListening();
      this.isRunning = false;
      this._dispatchStatusEvent('backendStopped');
    } catch (error) {
      console.error('[Response Linter] 停止后端服务失败:', error);
    }
  }

  updateSettings(settings) {
    try {
      this.settings = settings || {};
      fixCoordinator.updateSettings({
        enabled: this.settings.enabled,
        autoFix: this.settings.autoFix || false,
        defaultAutoFixAction: this.settings.defaultAutoFixAction,
      });
      this._syncListening();
    } catch (error) {
      console.error('[Response Linter] 更新后端设置失败:', error);
    }
  }

  _syncListening() {
    const settings = this.settings || {};
    // Automatic repair only needs event listening when at least one structure
    // feature is enabled. Manual repair reads the latest message directly.
    const shouldListen = settings.enabled === true && settings.autoFix === true && hasEnabledFeature(settings);
    if (shouldListen && !this.isRunning) this.start();
    else if (!shouldListen && this.isRunning) this.stop();
  }

  _getCurrentSettings() {
    try {
      const ctx = __getCtx();
      const fresh = ctx?.extensionSettings?.[this.extensionName];
      if (fresh && typeof fresh === 'object') {
        // Host namespace wins, but keep known controller fields for tests and
        // early partial settings objects. Generic `rules` are never consulted.
        return { ...(this.settings || {}), ...fresh };
      }
    } catch {}
    return this.settings || {};
  }

  // Compatibility surface: generic validation is no longer part of production.
  validateLatestMessage() { return null; }
  validateContent() { return null; }

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isRunning: this.isRunning,
      extensionName: this.extensionName,
      messageHandler: messageHandler.getStatus(),
      fixCoordinator: fixCoordinator.getStatus(),
    };
  }

  getStatistics() {
    const fixes = fixCoordinator.getStatistics();
    return {
      totalValidations: 0,
      failedValidations: 0,
      successfulFixes: fixes.successfulFixes,
      totalFixAttempts: fixes.totalTasks,
      userCancellations: fixes.userCancellations,
      lastActivity: this.statistics.lastActivity,
      successRate: 100,
    };
  }

  resetStatistics() {
    this.statistics = {
      totalValidations: 0,
      failedValidations: 0,
      successfulFixes: 0,
      totalFixAttempts: 0,
      userCancellations: 0,
      lastActivity: null,
    };
    fixCoordinator.resetStatistics();
  }

  cleanup() {
    try {
      messageHandler.cleanupProcessedMessages();
      fixCoordinator.cleanup();
    } catch (error) {
      console.error('[Response Linter] 后端内存清理失败:', error);
    }
  }

  _bindEventHandlers() {
    document.addEventListener('responseLinter.messageProcessed', event => {
      this._handleMessageProcessed(event.detail);
    });
  }

  async _handleMessageProcessed(messageData) {
    try {
      const settings = this._getCurrentSettings();
      if (settings.enabled !== true || settings.autoFix !== true) return;
      if (!hasEnabledFeature(settings)) return;
      const ctx = __getCtx();
      const found = findMessage(ctx, messageData.messageId);
      if (!found.message || found.message.is_user || found.message.is_system || isStreamingContext(ctx)) return;
      const autoTarget = captureAutoTarget(ctx, found.message);
      if (!isCurrentAutoTarget(autoTarget, ctx)) return;
      // Queue a target, not a text transform computed before another writer.
      // Even a currently clean message may change while waiting for the lock.
      this._enqueueAutoPlan({ success: true, messageId: found.resolvedId,
        message: found.message, swipeId: messageSwipeId(found.message),
        content: messageContent(found.message), fixedContent: '', autoTarget, settings,
        readSettings: () => this._getCurrentSettings() });
    } catch (error) {
      console.error('[Response Linter] 处理自动修复失败:', error, messageData);
    }
  }

  _enqueueAutoPlan(plan) {
    if (!plan?.success) return;
    const key = `${plan.messageId}|${plan.swipeId}|${plan.content}|${plan.fixedContent}`;
    const prior = this._autoPlanKeys.get(String(plan.messageId));
    const ticket = { key, chat: plan.autoTarget?.chat, message: plan.message, epoch: plan.autoTarget?.epoch };
    if (prior && prior.key === key && prior.chat === ticket.chat && prior.message === ticket.message && prior.epoch === ticket.epoch) return;
    this._autoPlanKeys.set(String(plan.messageId), ticket);
    const pending = fixCoordinator.queueRepairPlan(plan, { priority: 60 });
    Promise.resolve(pending).then(result => {
      if (!result?.success && /过期|取消|已变化|已切换|未完成/.test(result?.reason || result?.metadata?.reason || '')) {
        this._dispatchFixWarning(plan.messageId, [result.reason || result.metadata.reason], plan.content);
      } else if (result?.warnings?.length) this._dispatchFixWarning(plan.messageId, result.warnings, plan.content);
    }).finally(() => {
      if (this._autoPlanKeys.get(String(plan.messageId)) === ticket) {
        this._autoPlanKeys.delete(String(plan.messageId));
      }
    });
  }

  _dispatchFixWarning(messageId, warnings, content = '') {
    if (!Array.isArray(warnings) || !warnings.length) return;
    const key = `${messageId}|${String(content)}|${warnings.join('|')}`;
    if (this._warningKeys.get(String(messageId)) === key) return;
    this._warningKeys.set(String(messageId), key);
    this._dispatchFixEvent('fixWarning', { messageId, warnings });
  }

  _dispatchFixEvent(eventType, data) {
    try {
      document.dispatchEvent(new CustomEvent(`responseLinter.${eventType}`, {
        detail: { ...(data || {}), timestamp: new Date() },
      }));
    } catch (error) {
      console.error('[Response Linter] 分发修复事件失败:', error);
    }
  }

  _dispatchStatusEvent(eventType) {
    try {
      document.dispatchEvent(new CustomEvent(`responseLinter.${eventType}`, {
        detail: { timestamp: new Date(), status: this.getStatus() },
      }));
    } catch (error) {
      console.error('[Response Linter] 分发状态事件失败:', error);
    }
  }

  async triggerManualFix(messageId) {
    try {
      if (!fixCoordinator.isEnabled) return { success: false, reason: '扩展未启用' };
      const settings = this._getCurrentSettings();
      const plan = buildRepairPlan({
        messageId,
        settings,
        ctx: __getCtx(),
      });
      if (!plan.success) {
        return {
          success: false,
          reason: plan.reason || '没有可修复的问题',
          warnings: plan.warnings || [],
          suppressed: plan.suppressed === true,
          calendarResult: plan.calendarResult || null,
        };
      }
      const result = await fixCoordinator.queueRepairPlan(plan, { manual: true, priority: 100 });
      return {
        ...result,
        warnings: plan.warnings || [],
        calendarResult: plan.calendarResult || null,
      };
    } catch (error) {
      console.error('手动修复失败:', error);
      return { success: false, reason: '修复过程出错', error: error.message };
    }
  }

  async confirmFix(messageId, confirmed) {
    try {
      return await fixCoordinator.confirmFix(messageId, confirmed);
    } catch (error) {
      console.error('确认修复失败:', error);
      return { success: false, reason: '确认过程出错', error: error.message };
    }
  }

  // Compatibility method: generic strategy preview is gone. It intentionally
  // returns a failure without touching content or any engine state.
  previewFix() {
    return {
      success: false,
      reason: '1.4.10 已移除通用规则修复策略，请使用“修复最新回复”预览。',
      newContent: '',
      strategy: null,
    };
  }

  getLatestAIMessage() { return messageHandler.getLatestAIMessage(); }

  previewLatestFix() {
    const latest = this.getLatestAIMessage();
    if (!latest) return { success: false, reason: '未找到AI消息' };
    const settings = this._getCurrentSettings();
    const plan = buildRepairPlan({
      messageId: latest.id,
      settings,
      ctx: __getCtx(),
    });
    if (!plan.success) {
      return {
        success: false,
        reason: plan.reason || '当前消息无需修复',
        warnings: plan.warnings || [],
        originalContent: latest.content,
        newContent: latest.content,
      };
    }
    return {
      success: true,
      originalContent: plan.content,
      newContent: plan.fixedContent,
      strategy: plan.strategy,
      strategies: plan.strategies,
      warnings: plan.warnings,
      calendarResult: plan.calendarResult,
      messageId: plan.messageId,
      swipeId: plan.swipeId,
    };
  }

  async undoFix(messageId, steps = 1) {
    try {
      return await fixCoordinator.undoFix(messageId, steps);
    } catch (error) {
      console.error('撤销修复失败:', error);
      return { success: false, reason: '撤销过程出错', error: error.message };
    }
  }

  getFixHistory(messageId) {
    try { return fixCoordinator.getModificationHistory(messageId); }
    catch { return []; }
  }

  canUndoFix(messageId) {
    try { return fixCoordinator.canUndo(messageId); }
    catch { return false; }
  }

  getFixStatistics() {
    try {
      const stats = fixCoordinator.getStatistics();
      return {
        totalAttempts: stats.totalTasks,
        successfulFixes: stats.successfulFixes,
        userCancellations: stats.userCancellations,
        queueLength: stats.queueLength || 0,
        isProcessing: stats.isProcessing || false,
        successRate: stats.totalTasks > 0
          ? Math.round((stats.successfulFixes / stats.totalTasks) * 100)
          : 0,
      };
    } catch {
      return { totalAttempts: 0, successfulFixes: 0, userCancellations: 0, queueLength: 0, isProcessing: false, successRate: 0 };
    }
  }
}

export function createBackendController(extensionName) {
  return new BackendController(extensionName);
}
