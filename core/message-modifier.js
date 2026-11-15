// Response Linter 消息修改服务
// 基于SillyTavern的updateMessageBlock实现安全的消息内容修改和DOM更新

// 统一通过 getContext() 与宿主交互，避免直接导入扩展内部文件。
// 每次写入/确认前重新取上下文，优先实际宿主 window.SillyTavern.getContext。
import { getFreshContext, isStreamingContext, snapshotMessage, sameMessageState, chatIdentity, captureAutoTarget, isCurrentAutoTarget } from './host-context.js';
import { withMessageWriteLease, ownsWriteLease } from './message-write-lease.js';
const __getCtx = () => getFreshContext();

/**
 * 修改历史记录数据结构
 * @typedef {Object} ModificationRecord
 * @property {string} messageId - 消息ID
 * @property {string} originalContent - 原始内容
 * @property {string} modifiedContent - 修改后内容
 * @property {string} strategy - 修改策略
 * @property {Date} timestamp - 修改时间
 * @property {boolean} canUndo - 是否可撤销
 */

/**
 * 消息修改结果数据结构
 * @typedef {Object} ModificationResult
 * @property {boolean} success - 修改是否成功
 * @property {string} messageId - 消息ID
 * @property {string} originalContent - 原始内容
 * @property {string} newContent - 新内容
 * @property {Object} metadata - 修改元数据
 */

/**
 * 消息修改服务核心类
 */
export class MessageModifier {
  constructor() {
    this.modificationHistory = new Map(); // 按消息ID存储修改历史
    this.maxHistoryPerMessage = 10;
    this.isEnabled = false;
    this.pendingModifications = new Map(); // 待确认的修改
    this.activeWrites = new Set();
  }

  /**
   * 启用/禁用消息修改服务
   * @param {boolean} enabled - 是否启用
   */
  setEnabled(enabled) {
    this.isEnabled = enabled;
    console.log(`消息修改服务${enabled ? '已启用' : '已禁用'}`);
  }

  /**
   * 安全地修改消息内容
   * @param {string} messageId - 消息ID
   * @param {string} newContent - 新的消息内容
   * @param {string} strategy - 修改策略名称
   * @param {boolean} requireConfirmation - 是否需要用户确认
   * @returns {Promise<ModificationResult>} 修改结果
   */
  async modifyMessage(messageId, newContent, strategy = 'manual', requireConfirmation = false, expectedContent = null, options = {}) {
    messageId = String(messageId);
    if (!this.isEnabled) {
      return {
        success: false,
        messageId,
        originalContent: '',
        newContent,
        metadata: { reason: '消息修改服务未启用' },
      };
    }

    // Never replace a plan while its preview is still awaiting a decision.
    if (this.pendingModifications.size) {
      return { success: false, messageId, metadata: { reason: '请先确认或取消当前修复预览' } };
    }

    try {
      // 获取当前消息内容
      const currentMessage = this._getMessage(messageId);
      if (!currentMessage) {
        return {
          success: false,
          messageId,
          originalContent: '',
          newContent,
          metadata: { reason: '找不到指定的消息' },
        };
      }

      const originalContent = currentMessage.extra?.display_text ?? currentMessage.mes ?? '';
      if ((expectedContent !== null && originalContent !== expectedContent) ||
          (options.expectedState && !sameMessageState(currentMessage, options.expectedState))) {
        return { success: false, metadata: { reason: '消息已发生变化，请重新检查后修复' } };
      }

      // 如果内容没有变化，直接返回成功
      if (originalContent === newContent) {
        return {
          success: true,
          messageId,
          originalContent,
          newContent,
          metadata: { reason: '内容无变化' },
        };
      }

      // 如果需要确认，先存储待确认的修改
      if (requireConfirmation) {
        return await this._handleConfirmationRequired(messageId, originalContent, newContent, strategy, options.warnings || [], options);
      }

      // 直接执行修改
      return await this._executeModification(messageId, originalContent, newContent, strategy, options);
    } catch (error) {
      console.error('修改消息失败:', error);
      return {
        success: false,
        messageId,
        originalContent: '',
        newContent,
        metadata: { reason: '修改过程出错', error: error.message },
      };
    }
  }

  /**
   * 执行消息修改
   * @private
   * @param {string} messageId - 消息ID
   * @param {string} originalContent - 原始内容
   * @param {string} newContent - 新内容
   * @param {string} strategy - 修改策略
   * @returns {Promise<ModificationResult>} 修改结果
   */
  async _executeModification(messageId, originalContent, newContent, strategy, options = {}) {
    const message = this._getMessage(messageId);
    if (!message) return { success: false, metadata: { reason: '找不到指定的消息' } };
    const before = this._snapshot(message);
    const after = { ...before, mes: newContent, hasDisplay: true, display: newContent,
      hasExtra: true, swipe: before.hasSwipe ? newContent : before.swipe };
    const result = await this._writeState(messageId, message, after, options.expectedState || before, options);
    if (result.success) this._recordModification(messageId, originalContent, newContent, strategy, message, before, after);
    return { ...result, messageId, originalContent, newContent };
  }

  _snapshot(message) {
    return snapshotMessage(message);
  }

  _restore(message, state) {
    message.mes = state.mes;
    if (state.hasDisplay) {
      message.extra = message.extra || {};
      message.extra.display_text = state.display;
    } else if (message.extra) {
      delete message.extra.display_text;
      if (!state.hasExtra && Object.keys(message.extra).length === 0) delete message.extra;
    }
    if (state.hasSwipe) message.swipes[state.swipeId] = state.swipe;
  }

  // Roll back only fields which still contain our write. Never restore a whole
  // extra/swipe_info/metadata object over another plugin's memory updates.
  _rollbackOwned(message, before, written) {
    if (message.swipe_id === written.swipeId) {
      if (Object.is(message.mes, written.mes)) message.mes = before.mes;
      const hasDisplay = Object.prototype.hasOwnProperty.call(message.extra || {}, 'display_text');
      if (hasDisplay === written.hasDisplay && Object.is(message.extra?.display_text, written.display)) {
        if (before.hasDisplay) {
          message.extra ||= {};
          message.extra.display_text = before.display;
        } else if (message.extra) {
          delete message.extra.display_text;
          if (!before.hasExtra && Object.keys(message.extra).length === 0) delete message.extra;
        }
      }
    }
    if (written.hasSwipe && message.swipes === written.swipes &&
        Object.is(message.swipes[written.swipeId], written.swipe)) {
      message.swipes[written.swipeId] = before.swipe;
    }
  }

  async _writeState(messageId, message, state, expectedState = this._snapshot(message), options = {}) {
    const origin = __getCtx();
    const chat = origin?.chat;
    const id = chatIdentity(origin);
    const write = lease => {
      const fresh = __getCtx();
      if (fresh?.chat !== chat || chatIdentity(fresh) !== id || this._getMessage(messageId) !== message) {
        return { success: false, metadata: { reason: '聊天或消息已切换，本次修复已取消' } };
      }
      return this._writeStateLocked(messageId, message, state, expectedState, { ...options, lease });
    };
    if (options.lease) {
      if (!ownsWriteLease(options.lease, chat)) return { success: false, metadata: { reason: '写入租约已过期' } };
      return write(options.lease);
    }
    return withMessageWriteLease(chat, write);
  }

  async _writeStateLocked(messageId, message, state, expectedState, options) {
    if (this.activeWrites.has(messageId)) return { success: false, metadata: { reason: '此消息正在保存，请稍后重试' } };
    if (isStreamingContext(__getCtx())) {
      return { success: false, metadata: { reason: '当前回复仍在流式生成，已跳过写入，请等待生成完成' } };
    }
    this.activeWrites.add(messageId);
    const before = this._snapshot(message);
    const origin = __getCtx();
    const originChat = origin?.chat;
    const originId = chatIdentity(origin);
    // Once a later user/generation/chat/swipe boundary is visible, memory may
    // already have observed our text. Never roll that stable source backwards.
    const writeBoundary = captureAutoTarget(origin, originChat?.at(-1));
    const sameTarget = () => {
      const ctx = __getCtx();
      return ctx?.chat === originChat && chatIdentity(ctx) === originId &&
        this._getMessage(messageId) === message && message.swipe_id === state.swipeId;
    };
    const assertCurrent = expected => {
      if (!sameTarget() || !sameMessageState(message, expected) || isStreamingContext(__getCtx()) ||
          !isCurrentAutoTarget(writeBoundary) ||
          !ownsWriteLease(options.lease, originChat) ||
          (options.autoTarget && !isCurrentAutoTarget(options.autoTarget))) {
        const error = new Error('消息、候选回复或生成状态已变化，本次修复未完成');
        error.conflict = true;
        throw error;
      }
    };
    let wrote = false;
    let success = false;
    let saveStarted = false;
    try {
      assertCurrent(expectedState);
      document.dispatchEvent(new CustomEvent('responseLinter.messageWriteStarted', {
        detail: { messageId, message, chat: originChat, chatId: originId },
      }));
      // Event listeners run synchronously and may themselves change the target.
      assertCurrent(expectedState);
      this._restore(message, state);
      wrote = true;
      const rendered = await this._updateMessageBlock(messageId, message);
      if (!rendered.success) throw new Error(rendered.error || '消息显示更新失败');
      assertCurrent(state);
      const ctx = __getCtx();
      const save = ctx?.saveChat || ctx?.saveChatConditional;
      if (typeof save !== 'function') throw new Error('聊天保存接口不可用');
      saveStarted = true;
      await save.call(ctx);
      assertCurrent(state);
      success = true;
      return { success: true };
    } catch (error) {
      const canRollback = sameTarget() && isCurrentAutoTarget(writeBoundary) && !isStreamingContext(__getCtx());
      if (wrote && canRollback) {
        this._rollbackOwned(message, before, state);
        // Do not render an old chat/swipe into the currently visible one.
        if (sameTarget()) await this._updateMessageBlock(messageId, message);
      }
      return { success: false, metadata: {
        reason: wrote && !canRollback ? '正文已可见且已进入新轮次或切换消息，保留正文；保存状态未确认，本次修复未完成'
          : error.conflict ? error.message : '消息修改或保存失败',
        error: error.message, conflict: error.conflict === true,
        rollbackSkipped: wrote && !canRollback, saveStarted,
      } };
    } finally {
      this.activeWrites.delete(messageId);
      document.dispatchEvent(new CustomEvent('responseLinter.messageWriteFinished', {
        detail: { messageId, message, chat: originChat, chatId: originId, success,
          content: message.extra?.display_text ?? message.mes ?? '',
          committedState: success ? state : null },
      }));
    }
  }

  /**
   * 安全地调用SillyTavern的updateMessageBlock
   * @private
   * @param {string} messageId - 消息ID
   * @param {Object} message - 消息对象
   * @returns {Promise<Object>} 更新结果
   */
  async _updateMessageBlock(messageId, message) {
    try {
      const ctx = __getCtx();
      // 1) 优先使用 getContext 暴露的安全入口（ST 官方推荐）
      if (ctx && typeof ctx.updateMessageBlock === 'function') {
        await ctx.updateMessageBlock(messageId, message, { rerenderMessage: true });
        return { success: true };
      }

      // 2) 回退到全局函数（某些构建会暴露到 window）
      if (typeof window.updateMessageBlock === 'function') {
        await window.updateMessageBlock(messageId, message, { rerenderMessage: true });
        return { success: true };
      }

      // 3) 最后回退：动态导入根级 script.js 的导出（本仓库存在该导出）
      const { updateMessageBlock } = await import('../../../../../script.js');
      await updateMessageBlock(messageId, message, { rerenderMessage: true });
      return { success: true };
    } catch (error) {
      console.error('调用updateMessageBlock失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理需要确认的修改
   * @private
   * @param {string} messageId - 消息ID
   * @param {string} originalContent - 原始内容
   * @param {string} newContent - 新内容
   * @param {string} strategy - 修改策略
   * @returns {Promise<ModificationResult>} 修改结果
   */
  async _handleConfirmationRequired(messageId, originalContent, newContent, strategy, warnings = [], options = {}) {
    // 一次现取消息并同时记录消息/候选回复身份，确认时必须仍指向同一对象与同一 swipe。
    const message = this._getMessage(messageId);
    const ctx = __getCtx();
    const swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
    this.pendingModifications.set(messageId, {
      message,
      chat: ctx?.chat,
      chatId: chatIdentity(ctx),
      expectedState: this._snapshot(message),
      autoTarget: options.autoTarget,
      swipeId,
      originalContent,
      newContent,
      strategy,
      warnings: Array.isArray(warnings) ? [...warnings] : [],
      timestamp: new Date(),
    });

    // 触发确认事件
    this._dispatchConfirmationEvent(messageId, originalContent, newContent, strategy, warnings);

    return {
      success: false,
      messageId,
      originalContent,
      newContent,
      metadata: { reason: '等待用户确认', requiresConfirmation: true },
    };
  }

  /**
   * 确认待处理的修改
   * @param {string} messageId - 消息ID
   * @param {boolean} confirmed - 是否确认修改
   * @returns {Promise<ModificationResult>} 修改结果
   */
  async confirmModification(messageId, confirmed) {
    messageId = String(messageId);
    const pendingModification = this.pendingModifications.get(messageId);
    if (!pendingModification) {
      return {
        success: false,
        messageId,
        originalContent: '',
        newContent: '',
        metadata: { reason: '没有待确认的修改' },
      };
    }

    // 清理待确认记录
    this.pendingModifications.delete(messageId);

    if (confirmed) {
      const ctx = __getCtx();
      const current = this._getMessage(messageId);
      const currentSwipeId = Number.isInteger(current?.swipe_id) ? current.swipe_id : null;
      if (!this.isEnabled || ctx?.chat !== pendingModification.chat || chatIdentity(ctx) !== pendingModification.chatId ||
          current !== pendingModification.message || currentSwipeId !== pendingModification.swipeId ||
          !sameMessageState(current, pendingModification.expectedState) ||
          (pendingModification.autoTarget && !isCurrentAutoTarget(pendingModification.autoTarget))) {
        return { success: false, metadata: { reason: '消息或启用状态已变化，请重新修复' } };
      }
      // 执行修改
      const result = await this._executeModification(
        messageId,
        pendingModification.originalContent,
        pendingModification.newContent,
        pendingModification.strategy,
        { expectedState: pendingModification.expectedState, autoTarget: pendingModification.autoTarget },
      );
      return { ...result, warnings: pendingModification.warnings || [] };
    } else {
      // 用户取消修改
      return {
        success: false,
        messageId,
        originalContent: pendingModification.originalContent,
        newContent: pendingModification.newContent,
        metadata: { reason: '用户取消修改' },
      };
    }
  }

  /**
   * 撤销消息修改
   * @param {string} messageId - 消息ID
   * @param {number} steps - 撤销步数，默认1
   * @returns {Promise<ModificationResult>} 撤销结果
   */
  async undoModification(messageId, steps = 1) {
    messageId = String(messageId);
    const history = this.getModificationHistory(messageId);
    if (!Number.isInteger(steps) || steps < 1 || !history.length) {
      return { success: false, metadata: { reason: '没有可撤销的修改或撤销步数无效' } };
    }
    const message = this._getMessage(messageId);
    const latest = history[history.length - 1];
    const current = this._snapshot(message);
    if (!sameMessageState(message, latest.after)) {
      return { success: false, metadata: { reason: '消息已被编辑，请勿覆盖后续修改' } };
    }
    const targetIndex = Math.max(0, history.length - steps);
    const before = history[targetIndex].before;
    const result = await this._writeState(messageId, message, before);
    if (result.success) {
      this.modificationHistory.set(messageId, history.slice(0, targetIndex));
      this.pendingModifications.delete(messageId);
    }
    return { ...result, messageId, newContent: before.display ?? before.mes };
  }

  /**
   * 获取消息对象
   * @private
   * @param {string} messageId - 消息ID
   * @returns {Object|null} 消息对象
   */
  _getMessage(messageId) {
    try {
      const context = __getCtx();
      if (!context?.chat?.length) {
        return null;
      }

      // 通过messageId查找消息：先严格匹配 msg.id，再回退到索引匹配
      let message = context.chat.find(msg => msg.id == messageId);
      if (!message) {
        const idx = Number.parseInt(messageId, 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < context.chat.length) {
          message = context.chat[idx];
        }
      }
      return message || null;
    } catch (error) {
      console.error('获取消息失败:', error);
      return null;
    }
  }

  /**
   * 获取消息的原始内容
   * @private
   * @param {string} messageId - 消息ID
   * @returns {string} 原始内容
   */
  _getOriginalContent(messageId) {
    const history = this.modificationHistory.get(messageId);
    if (history && history.length > 0) {
      return history[0].originalContent;
    }

    // 如果没有历史记录，尝试从当前消息获取
    const message = this._getMessage(messageId);
    return message ? message.mes || '' : '';
  }

  /**
   * 记录修改历史
   * @private
   * @param {string} messageId - 消息ID
   * @param {string} originalContent - 原始内容
   * @param {string} modifiedContent - 修改后内容
   * @param {string} strategy - 修改策略
   */
  _recordModification(messageId, originalContent, modifiedContent, strategy, message, before, after) {
    this.getModificationHistory(messageId);
    if (!this.modificationHistory.has(messageId)) {
      this.modificationHistory.set(messageId, []);
    }

    const history = this.modificationHistory.get(messageId);

    const record = {
      messageId,
      originalContent,
      message, before, after,
      chat: __getCtx()?.chat, chatId: chatIdentity(__getCtx()),
      modifiedContent,
      strategy,
      timestamp: new Date(),
      canUndo: true,
    };

    history.push(record);

    // 限制历史记录大小
    if (history.length > this.maxHistoryPerMessage) {
      history.shift(); // 移除最旧的记录
    }
  }

  /**
   * 移除最后一次修改记录
   * @private
   * @param {string} messageId - 消息ID
   */
  _removeLastModification(messageId) {
    const history = this.modificationHistory.get(messageId);
    if (history && history.length > 0) {
      history.pop();
    }
  }

  /**
   * 分发确认事件
   * @private
   * @param {string} messageId - 消息ID
   * @param {string} originalContent - 原始内容
   * @param {string} newContent - 新内容
   * @param {string} strategy - 修改策略
   */
  _dispatchConfirmationEvent(messageId, originalContent, newContent, strategy, warnings = []) {
    try {
      const event = new CustomEvent('responseLinter.modificationConfirmationRequired', {
        detail: {
          messageId,
          originalContent,
          newContent,
          strategy,
          warnings: Array.isArray(warnings) ? [...warnings] : [],
          timestamp: new Date(),
        },
      });

      document.dispatchEvent(event);
    } catch (error) {
      console.error('分发确认事件失败:', error);
    }
  }

  /**
   * 获取消息的修改历史
   * @param {string} messageId - 消息ID
   * @returns {Array<ModificationRecord>} 修改历史
   */
  getModificationHistory(messageId) {
    messageId = String(messageId);
    const history = this.modificationHistory.get(messageId) || [];
    const current = this._getMessage(messageId);
    if (history.length && (history[0].chat !== __getCtx()?.chat || history[0].chatId !== chatIdentity(__getCtx()) ||
        history[0].message !== current || history[0].before.swipeId !== current?.swipe_id)) {
      this.modificationHistory.delete(messageId);
      return [];
    }
    return history;
  }

  /**
   * 检查消息是否可以撤销
   * @param {string} messageId - 消息ID
   * @returns {boolean} 是否可以撤销
   */
  canUndo(messageId) {
    return this.getModificationHistory(messageId).length > 0;
  }

  /**
   * 获取待确认的修改列表
   * @returns {Array<Object>} 待确认修改列表
   */
  getPendingModifications() {
    return Array.from(this.pendingModifications.entries()).map(([messageId, modification]) => ({
      messageId,
      ...modification,
    }));
  }

  /**
   * 清理修改历史
   * @param {string} messageId - 消息ID，如果不提供则清理所有
   */
  clearHistory(messageId = null) {
    if (messageId) {
      this.modificationHistory.delete(messageId);
      console.log(`消息 ${messageId} 的修改历史已清理`);
    } else {
      this.modificationHistory.clear();
      console.log('所有修改历史已清理');
    }
  }

  /**
   * 获取修改服务状态
   * @returns {Object} 状态信息
   */
  getStatus() {
    return {
      isEnabled: this.isEnabled,
      totalModifiedMessages: this.modificationHistory.size,
      pendingModifications: this.pendingModifications.size,
      totalModifications: Array.from(this.modificationHistory.values()).reduce(
        (sum, history) => sum + history.length,
        0,
      ),
    };
  }
}

// 创建全局消息修改服务实例
export const messageModifier = new MessageModifier();
