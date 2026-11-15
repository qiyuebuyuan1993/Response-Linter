// Response Linter 修复协调器
// 协调验证失败事件和修复执行，管理修复流程和用户交互

import { getFreshContext, isStreamingContext, isCurrentAutoTarget } from './host-context.js';
import { messageModifier } from './message-modifier.js';
import { buildRepairPlan } from './repair-service.js';
import { withMessageWriteLease } from './message-write-lease.js';

/**
 * 修复任务数据结构
 * @typedef {Object} FixTask
 * @property {string} messageId - 消息ID
 * @property {string} content - 消息内容
 * @property {Array<string>} missingItems - 缺失项
 * @property {string} ruleName - 触发的规则名称
 * @property {string} fixStrategy - 修复策略
 * @property {number} priority - 任务优先级
 * @property {Date} createdAt - 创建时间
 * @property {string} status - 任务状态
 */

/**
 * 修复协调器核心类
 */
export class FixCoordinator {
  constructor() {
    this.isEnabled = false;
    this.autoFixEnabled = false;
    this.requireConfirmation = true;

    this.fixQueue = [];
    this.maxQueueSize = 20;
    this.isProcessing = false;

    this.statistics = {
      totalTasks: 0,
      successfulFixes: 0,
      failedFixes: 0,
      userCancellations: 0,
    };

    // 绑定事件处理器
    this._bindEventHandlers();
  }

  /**
   * 初始化修复协调器
   * @param {Object} settings - 配置设置
   */
  initialize(settings) {
    this.isEnabled = !!settings.enabled;
    this.autoFixEnabled = !!settings.autoFix;
    // 由“自动修复默认行为”决定是否需要确认：preview=需要确认；apply=直接应用
    this.requireConfirmation = (settings?.defaultAutoFixAction === 'preview');

    messageModifier.setEnabled(this.isEnabled);

    console.log(`修复协调器已初始化 - 自动修复: ${this.autoFixEnabled ? '启用' : '禁用'}，默认行为: ${this.requireConfirmation ? '预览确认' : '直接应用'}`);
  }

  /**
   * 更新设置
   * @param {Object} settings - 新设置
   */
  updateSettings(settings) {
    this.isEnabled = !!settings.enabled;
    this.autoFixEnabled = !!settings.autoFix;
    this.requireConfirmation = (settings?.defaultAutoFixAction === 'preview');

    // 同步更新相关服务
    messageModifier.setEnabled(this.isEnabled);

    console.log(`修复协调器设置已更新 - 自动修复: ${this.autoFixEnabled ? '启用' : '禁用'}，默认行为: ${this.requireConfirmation ? '预览确认' : '直接应用'}`);
  }

  /**
   * 绑定事件处理器
   * @private
   */
  _bindEventHandlers() {
    // 1.4.10 intentionally has no validationFailed -> generic repair listener.
    // Only shared repair plans produced by repair-service may enter the queue.
    document.addEventListener('responseLinter.modificationConfirmationRequired', event => {
      this._handleModificationConfirmationRequired(event.detail);
    });
  }

  // Compatibility no-op for older callers/events. Generic rules are never
  // converted into a fix task.
  async _handleValidationFailed() {
    return;
  }

  /**
   * 处理修改确认请求事件
   * @private
   * @param {Object} eventData - 确认请求事件数据
   */
  _handleModificationConfirmationRequired(eventData) {
    const { messageId, originalContent, newContent, strategy, warnings, token } = eventData;

    // 触发UI确认对话框
    this._showConfirmationDialog(messageId, originalContent, newContent, strategy, warnings, token);
  }

  /**
   * 添加任务到修复队列
   * @private
   * @param {FixTask} task - 修复任务
   */
  _addToQueue(task) {
    // 计划任务已经携带生成时的消息对象与 swipe 身份；不能在这里重新取最新消息，
    // 否则预览/队列期间切换候选回复会被悄悄替换。旧任务才按当前上下文补身份。
    if (!task.message) task.message = messageModifier._getMessage(task.messageId);
    if (task.swipeId === undefined) {
      task.swipeId = Number.isInteger(task.message?.swipe_id) ? task.message.swipe_id : null;
    }
    // 检查队列大小
    if (this.fixQueue.length >= this.maxQueueSize) {
      console.warn('修复队列已满，丢弃最旧的任务');
      const dropped = this.fixQueue.shift();
      dropped.resolve?.({ success: false, reason: '修复队列已满' });
    }

    // 按优先级插入队列
    const insertIndex = this.fixQueue.findIndex(t => t.priority < task.priority);
    if (insertIndex === -1) {
      this.fixQueue.push(task);
    } else {
      this.fixQueue.splice(insertIndex, 0, task);
    }

    console.log(`修复任务已添加到队列 [${task.messageId}] - 策略: ${task.fixStrategy}`);

    // 开始处理队列
    this._processQueue();
  }

  /**
   * 处理修复队列
   * @private
   */
  async _processQueue() {
    if (this.isProcessing || this.fixQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.fixQueue.length > 0) {
      const task = this.fixQueue.shift();

      try {
        const result = await this._processFixTask(task);
        task.resolve?.(result);
        this._dispatchFixEvent('fixStatisticsChanged', {});

        // 添加小延迟避免阻塞UI
        await this._sleep(100);
      } catch (error) {
        console.error('处理修复任务失败:', error, task);
        task.status = 'failed';
        this.statistics.failedFixes++;
        task.resolve?.({ success: false, reason: error.message });
      }
    }

    this.isProcessing = false;
  }

  /**
   * 处理单个修复任务
   * @private
   * @param {FixTask} task - 修复任务
   */
  async _processFixTask(task) {
    const ctx = getFreshContext();
    const chat = task.chat || ctx?.chat;
    return withMessageWriteLease(chat, async lease => {
      if (getFreshContext()?.chat !== chat || messageModifier._getMessage(task.messageId) !== task.message ||
          (Number.isInteger(task.message?.swipe_id) ? task.message.swipe_id : null) !== task.swipeId) {
        return { success: false, reason: '聊天或候选回复已切换，本次修复已取消' };
      }
      if (task.autoTarget) {
        if (!isCurrentAutoTarget(task.autoTarget)) return { success: false, reason: '自动修复已过期，未修改历史消息' };
        const settings = task.readSettings?.() || task.settings || {};
        if (!this.isEnabled || !this.autoFixEnabled || settings.enabled !== true || settings.autoFix !== true) {
          return { success: false, reason: '自动修复已关闭，本次任务已取消' };
        }
        // The other plugin may have completed a rewrite while we waited.
        // Compute from the latest text only after acquiring the shared lock.
        const fresh = buildRepairPlan({ messageId: task.messageId, settings,
          ctx: getFreshContext(), automatic: true });
        if (!fresh.success) return { success: false, reason: fresh.reason, warnings: fresh.warnings };
        Object.assign(task, { content: fresh.content, plannedContent: fresh.fixedContent,
          expectedState: fresh.expectedState, fixStrategy: fresh.strategy,
          strategies: fresh.strategies, warnings: fresh.warnings });
      }
      return this._processFixTaskLocked(task, lease);
    });
  }

  async _processFixTaskLocked(task, lease) {
    try {
      if (!this.isEnabled) return { success: false, reason: '扩展未启用' };
      if (task.autoTarget && !isCurrentAutoTarget(task.autoTarget)) {
        return { success: false, reason: '新消息或新一轮生成已开始，自动修复已取消' };
      }
      if (isStreamingContext(getFreshContext())) {
        return { success: false, reason: '当前回复仍在流式生成中，已跳过修复，请等待生成完成。' };
      }
      const currentMessage = messageModifier._getMessage(task.messageId);
      const currentSwipeId = Number.isInteger(currentMessage?.swipe_id) ? currentMessage.swipe_id : null;
      if (currentMessage !== task.message || currentSwipeId !== task.swipeId) {
        return { success: false, reason: '聊天或候选回复已切换，请重新修复' };
      }
      task.status = 'processing';
      this.statistics.totalTasks++;

      console.log(`开始处理修复任务 [${task.messageId}] - 策略: ${task.fixStrategy}`);

      if (typeof task.plannedContent !== 'string') {
        // There is deliberately no fallback to the 1.4.9 strategy engine.
        task.status = 'failed';
        this.statistics.failedFixes++;
        return { success: false, reason: '旧版通用规则修复路径已移除，请重新生成结构修复计划。' };
      }
      // Manual/auto/preview share one already-computed plan.
      const fixResult = {
        success: task.plannedContent !== task.content,
        originalContent: task.content,
        fixedContent: task.plannedContent,
        strategy: task.fixStrategy,
        fixedItems: [],
        metadata: {
          pipeline: Array.isArray(task.strategies) ? task.strategies : [],
          warnings: Array.isArray(task.warnings) ? task.warnings : [],
          planned: true,
          reason: task.plannedContent === task.content ? '内容无变化' : undefined,
        },
      };

      if (fixResult.success) {
        // 修复成功，应用到消息
        const modificationResult = await messageModifier.modifyMessage(
          task.messageId,
          fixResult.fixedContent,
          task.fixStrategy,
          this.requireConfirmation,
          task.content,
          { warnings: fixResult.metadata?.warnings || task.warnings || [],
            expectedState: task.expectedState, autoTarget: task.autoTarget, lease },
        );

        if (modificationResult.success) {
          task.status = 'completed';
          this.statistics.successfulFixes++;

          console.log(`修复任务完成 [${task.messageId}] - 策略: ${task.fixStrategy}`);

          // 触发修复成功事件
          this._dispatchFixEvent('fixApplied', {
            task,
            fixResult,
            modificationResult,
          });

          // 可选：重新验证修复结果
          if (this._shouldRevalidate(task)) {
            await this._revalidateMessage(task.messageId, fixResult.fixedContent);
          }
        } else if (modificationResult.metadata?.requiresConfirmation) {
          task.status = 'pending_confirmation';
          console.log(`修复任务等待用户确认 [${task.messageId}]`);
        } else {
          task.status = 'failed';
          this.statistics.failedFixes++;
          console.error(`修复任务失败 - 消息修改失败 [${task.messageId}]`, modificationResult);
        }
        return {
          ...modificationResult,
          reason: modificationResult.metadata?.reason,
          warnings: fixResult.metadata?.warnings || task.warnings || [],
        };
      } else {
        task.status = 'failed';
        this.statistics.failedFixes++;
        return { success: false, reason: fixResult.metadata?.reason || '无法修复' };
      }
    } catch (error) {
      task.status = 'failed';
      this.statistics.failedFixes++;
      console.error('处理修复任务出错:', error, task);
      return { success: false, reason: error.message };
    }
  }

  /**
   * 计算任务优先级
   * @private
   * @param {Object} validationResult - 验证结果
   * @returns {number} 优先级数值（越高越优先）
   */
  _calculatePriority(validationResult) {
    let priority = 50; // 基础优先级

    // 根据缺失项数量调整优先级
    priority += Math.min(validationResult.missingContent.length * 10, 30);

    // 根据修复策略调整优先级
    switch (validationResult.fixStrategy) {
      case 'thinking-content':
        priority += 20; // 思维链修复优先级较高
        break;
      case 'add-missing-tags':
        priority += 10; // 标签修复中等优先级
        break;
      case 'custom':
        priority += 5; // 自定义策略优先级较低
        break;
    }

    return Math.min(priority, 100); // 限制最大优先级
  }

  /**
   * 显示确认对话框
   * @private
   * @param {string} messageId - 消息ID
   * @param {string} originalContent - 原始内容
   * @param {string} newContent - 新内容
   * @param {string} strategy - 修复策略
   */
  _showConfirmationDialog(messageId, originalContent, newContent, strategy, warnings = [], token) {
    // 创建确认对话框内容
    const dialogContent = this._createConfirmationDialog(messageId, originalContent, newContent, strategy, warnings);

    // 触发UI显示事件
    this._dispatchFixEvent('confirmationRequired', {
      token,
      messageId,
      originalContent,
      newContent,
      strategy,
      warnings,
      dialogContent,
    });
  }

  /**
   * 创建确认对话框内容
   * @private
   * @param {string} messageId - 消息ID
   * @param {string} originalContent - 原始内容
   * @param {string} newContent - 新内容
   * @param {string} strategy - 修复策略
   * @returns {string} 对话框HTML内容
   */
  _createConfirmationDialog(messageId, originalContent, newContent, strategy, warnings = []) {
    const strategyNames = {
      'thinking-content': '思维链格式修复',
      'add-missing-tags': '添加缺失标签',
      custom: '自定义修复',
      'remove-leaked-reasoning': '清理泄漏推理',
      'sdc-content-boundary': '修复 SDC/正文边界',
      'details-outside-content-order': '修复正文外折叠块顺序与配对',
    };

    const strategyName = String(strategy || '').split(' | ').map(name => strategyNames[name] || name).join(' + ');
    const warningHtml = warnings.length
      ? `<div class="rl-confirmation-warnings"><h4>注意：</h4><ul>${warnings.map(item => `<li>${this._escapeHtml(item)}</li>`).join('')}</ul></div>`
      : '';

    return `
            <div class="rl-fix-confirmation">
                <h3>确认自动修复</h3>
                <p><strong>修复策略</strong>: ${strategyName}</p>
                <p><strong>消息ID</strong>: ${messageId}</p>
                ${warningHtml}
                
                <div class="rl-content-comparison">
                    <div class="rl-original">
                        <h4>原始内容：</h4>
                        <pre>${this._escapeHtml(originalContent.substring(0, 200))}${
      originalContent.length > 200 ? '...' : ''
    }</pre>
                    </div>
                    <div class="rl-modified">
                        <h4>修复后内容：</h4>
                        <pre>${this._escapeHtml(newContent.substring(0, 200))}${
      newContent.length > 200 ? '...' : ''
    }</pre>
                    </div>
                </div>
                
                <div class="rl-confirmation-buttons">
                    <button class="rl-confirm-fix" data-message-id="${messageId}">应用修复</button>
                    <button class="rl-cancel-fix" data-message-id="${messageId}">取消</button>
                    <button class="rl-show-full-diff" data-message-id="${messageId}">查看完整差异</button>
                </div>
            </div>
        `;
  }

  /**
   * 转义HTML字符
   * @private
   * @param {string} text - 要转义的文本
   * @returns {string} 转义后的文本
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * 确认修复操作
   * @param {string} messageId - 消息ID
   * @param {boolean} confirmed - 是否确认
   * @returns {Promise<Object>} 确认结果
   */
  async confirmFix(messageId, confirmed, token = null) {
    const result = await messageModifier.confirmModification(messageId, confirmed, token);

    if (confirmed && result.success) {
      this.statistics.successfulFixes++;
      this._dispatchFixEvent('fixConfirmed', { messageId, warnings: result.warnings || [], result });
    } else if (!confirmed && result.metadata?.reason === '用户取消修改') {
      this.statistics.userCancellations++;
      this._dispatchFixEvent('fixCancelled', { messageId });
    }

    return result;
  }

  /**
   * 撤销修复操作
   * @param {string} messageId - 消息ID
   * @param {number} steps - 撤销步数
   * @returns {Promise<Object>} 撤销结果
   */
  async undoFix(messageId, steps = 1) {
    const result = await messageModifier.undoModification(messageId, steps);

    if (result.success) {
      this._dispatchFixEvent('fixUndone', { messageId, steps, result });
    }

    return result;
  }

  /**
   * 手动触发修复
   * @param {string} messageId - 消息ID
   * @param {string} content - 消息内容
   * @param {Array<string>} missingItems - 缺失项
   * @param {string} strategy - 修复策略
   * @returns {Promise<Object>} 修复结果
   */
  async triggerManualFix() {
    return {
      success: false,
      reason: '旧版通用规则手动修复已移除，请通过“修复最新回复”使用结构修复计划。',
    };
  }

  /**
   * 入队由 repair-service 生成好的完整计划（手动/自动/预览共用）。
   * 计划携带消息对象与 swipe 身份，队列执行时会再次核对。
   * @param {Object} plan
   * @param {{resolve?:Function, priority?:number}} options
   */
  queueRepairPlan(plan, options = {}) {
    if (!this.isEnabled) return Promise.resolve({ success: false, reason: '扩展未启用' });
    if (!plan || !plan.success || typeof plan.fixedContent !== 'string') {
      return Promise.resolve({ success: false, reason: plan?.reason || '修复计划无效' });
    }
    return new Promise(resolve => this._addToQueue({
      messageId: plan.messageId,
      content: plan.content,
      fixedContent: plan.fixedContent,
      plannedContent: plan.fixedContent,
      strategies: plan.strategies || [],
      warnings: plan.warnings || [],
      missingItems: [],
      featureChanged: plan.featureChanged === true,
      revalidate: false,
      fixStrategy: plan.strategy || 'structure',
      message: plan.message,
      expectedState: plan.expectedState,
      autoTarget: plan.autoTarget,
      chat: plan.autoTarget?.chat || getFreshContext()?.chat,
      settings: plan.settings?.raw || plan.settings,
      readSettings: plan.readSettings,
      swipeId: Number.isInteger(plan.swipeId) ? plan.swipeId : null,
      priority: Number.isFinite(options.priority) ? options.priority : (options.manual ? 100 : 60),
      createdAt: new Date(),
      status: 'pending',
      resolve,
    }));
  }

  getModificationHistory(messageId) { return messageModifier.getModificationHistory(messageId); }
  canUndo(messageId) { return messageModifier.canUndo(messageId); }
  resetStatistics() {
    this.statistics = { totalTasks: 0, successfulFixes: 0, failedFixes: 0, userCancellations: 0 };
  }

  /**
   * 检查是否应该重新验证
   * @private
   * @param {FixTask} task - 修复任务
   * @returns {boolean} 是否需要重新验证
   */
  _shouldRevalidate() {
    // Generic post-fix validation was removed with the legacy rule engine.
    return false;
  }

  async _revalidateMessage() {
    return;
  }

  /**
   * 分发修复事件
   * @private
   * @param {string} eventType - 事件类型
   * @param {Object} data - 事件数据
   */
  _dispatchFixEvent(eventType, data) {
    try {
      const event = new CustomEvent(`responseLinter.${eventType}`, {
        detail: {
          ...data,
          timestamp: new Date(),
        },
      });

      document.dispatchEvent(event);
    } catch (error) {
      console.error('分发修复事件失败:', error);
    }
  }

  /**
   * 获取修复统计信息
   * @returns {Object} 统计信息
   */
  getStatistics() {
    return {
      ...this.statistics,
      queueLength: this.fixQueue.length,
      isProcessing: this.isProcessing,
      successRate:
        this.statistics.totalTasks > 0
          ? Math.round((this.statistics.successfulFixes / this.statistics.totalTasks) * 100)
          : 0,
    };
  }

  /**
   * 获取协调器状态
   * @returns {Object} 状态信息
   */
  getStatus() {
    return {
      isEnabled: this.isEnabled,
      autoFixEnabled: this.autoFixEnabled,
      requireConfirmation: this.requireConfirmation,
      queueLength: this.fixQueue.length,
      isProcessing: this.isProcessing,
      statistics: this.getStatistics(),
    };
  }

  /**
   * 清理队列和历史
   */
  cleanup() {
    for (const task of this.fixQueue) task.resolve?.({ success: false, reason: '任务已取消' });
    this.fixQueue = [];
    messageModifier.clearHistory();

    console.log('修复协调器已清理');
  }

  /**
   * 睡眠函数
   * @private
   * @param {number} ms - 毫秒数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 创建全局修复协调器实例
export const fixCoordinator = new FixCoordinator();
