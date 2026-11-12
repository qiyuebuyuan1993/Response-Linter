// Response Linter UI状态管理器
// 重构自原UIState对象，保持完全向后兼容

/**
 * UI状态管理器类
 * 管理扩展的所有UI状态，包括启用状态、规则、统计等
 */
export class UIStateManager {
  constructor() {
    // 核心状态属性
    this.isExtensionEnabled = false;
    this.isAutoFixEnabled = false;
    this.rules = [];
    this.currentEditingRule = null;
    this.isGuideExpanded = false; // 使用指引展开状态
  }

  /**
   * 静态初始化方法
   * 创建全局实例并设置向后兼容性
   */
  static async initialize() {
    try {
      console.log('📊 初始化UIStateManager...');

      // 创建全局命名空间
      if (!window.ResponseLinter) {
        window.ResponseLinter = {};
      }

      // 创建UIStateManager实例
      const uiStateInstance = new UIStateManager();

      // 设置到全局命名空间
      window.ResponseLinter.UIState = uiStateInstance;

      // 向后兼容：在全局scope创建UIState（保持现有代码工作）
      window.UIState = uiStateInstance;

      console.log('✅ UIStateManager初始化完成，向后兼容性已建立');
    } catch (error) {
      console.error('❌ UIStateManager初始化失败:', error);
      throw error;
    }
  }

  /**
   * 更新状态指示器
   * 根据扩展状态更新UI中的状态显示
   */
  updateStatusIndicator() {
    try {
      const indicator = $('#rl-status-indicator');

      // 需要访问全局的backendController
      const backendStatus = window.backendController ? window.backendController.getStatus() : { isRunning: false };

      if (!this.isExtensionEnabled) {
        indicator.removeClass('active warning error').addClass('disabled');
        indicator.attr('title', '扩展已禁用');
      } else if (!backendStatus.isRunning) {
        indicator.removeClass('active disabled error').addClass('warning');
        indicator.attr('title', '后端服务未运行');
      } else if (this.rules.filter(r => r.enabled).length === 0) {
        indicator.removeClass('active disabled error').addClass('warning');
        indicator.attr('title', '无活跃规则');
      } else {
        indicator.removeClass('disabled warning error').addClass('active');
        indicator.attr('title', '扩展运行中');
      }

      // 智能指引：如果无规则且指引未展开，自动展开
      this.checkAutoExpandGuide();
    } catch (error) {
      console.error('更新状态指示器失败:', error);
    }
  }

  /**
   * 检查是否需要自动展开指引
   */
  checkAutoExpandGuide() {
    try {
      const hasRules = this.rules.length > 0;
      const isEnabled = this.isExtensionEnabled;

      // 如果扩展已启用但没有规则，且指引当前收起，则自动展开
      if (isEnabled && !hasRules && !this.isGuideExpanded) {
        this.toggleGuide(true);

        // 使用全局toastr显示提示
        if (window.toastr) {
          window.toastr.info('建议先添加验证规则来开始使用扩展', '响应检查器', { timeOut: 3000 });
        }
      }
    } catch (error) {
      console.error('检查自动展开指引失败:', error);
    }
  }

  /**
   * 切换使用指引展开状态
   * @param {boolean|null} forceExpand - 强制展开状态，null表示切换
   */
  toggleGuide(forceExpand = null) {
    try {
      const content = $('#rl-guide-content');
      const toggle = $('#rl-toggle-guide');

      if (forceExpand !== null) {
        this.isGuideExpanded = forceExpand;
      } else {
        this.isGuideExpanded = !this.isGuideExpanded;
      }

      if (this.isGuideExpanded) {
        content.slideDown(300);
        toggle.addClass('expanded');
      } else {
        content.slideUp(300);
        toggle.removeClass('expanded');
      }

      // 保存指引展开状态到本地存储
      localStorage.setItem('rl-guide-expanded', this.isGuideExpanded);
    } catch (error) {
      console.error('切换指引状态失败:', error);
    }
  }

  /**
   * 加载指引展开状态
   */
  loadGuideState() {
    try {
      const savedState = localStorage.getItem('rl-guide-expanded');
      if (savedState !== null) {
        this.isGuideExpanded = savedState === 'true';
        if (this.isGuideExpanded) {
          $('#rl-guide-content').show();
          $('#rl-toggle-guide').addClass('expanded');
        }
      }
    } catch (error) {
      console.error('加载指引状态失败:', error);
    }
  }

  /**
   * 更新统计显示
   * 从后端控制器获取统计数据并更新UI
   */
  updateStatistics() {
    try {
      // 访问全局的后端控制器
      if (!window.backendController) {
        console.warn('后端控制器未初始化，跳过统计更新');
        return;
      }

      const stats = window.backendController.getStatistics();
      const fixStats = window.backendController.getFixStatistics();

      // 更新统计显示元素
      $('#rl-stat-validations').text(stats.totalValidations);
      $('#rl-stat-fixes').text(stats.successfulFixes);
      $('#rl-stat-fix-attempts').text(stats.totalFixAttempts);
      $('#rl-stat-cancellations').text(stats.userCancellations);
      $('#rl-stat-fix-success').text(fixStats.successRate + '%');
      $('#rl-stat-success').text(stats.successRate + '%');

      // 更新手动修复按钮状态
      const latestMessageId = this.getLatestAIMessageId();
      $('#rl-manual-fix').prop('disabled', latestMessageId === null || !this.isExtensionEnabled);
      $('#rl-undo-fix').prop('disabled', latestMessageId === null || !window.backendController.canUndoFix(latestMessageId));
    } catch (error) {
      console.error('更新统计显示失败:', error);
    }
  }

  /**
   * 获取最新AI消息的ID（从index.js移动过来的辅助方法）
   * @returns {string|null} 消息ID或null
   */
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

// 导出单例模式的便捷访问方法
export function getUIState() {
  return window.UIState || window.ResponseLinter?.UIState;
}
