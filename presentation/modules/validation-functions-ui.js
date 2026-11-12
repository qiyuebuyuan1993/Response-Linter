// Response Linter 验证功能UI模块
// 重构自index.js中的ValidationFunctions对象，保持完全向后兼容

/**
 * 验证功能UI类
 * 负责手动验证触发、验证结果通知、自动修复触发等UI操作
 */
export class ValidationFunctionsUI {
  constructor() {
    this.isInitialized = false;
    /**
     * 依赖注入：后端控制器与 UI 状态
     * @type {any}
     */
    this._controller = null; // 后端控制器（通过 UIModuleManager.finalizeInitialization 注入）
    this._uiState = null;    // UIState 实例（通过 UIModuleManager.finalizeInitialization 注入）
  }

  // 兼容访问器：优先使用注入的 controller/uiState，不存在时回退全局
  get controller() { return this._controller || window.backendController || window.ResponseLinter?.BackendController || null; }
  get uiState() { return this._uiState || window.UIState || window.ResponseLinter?.UIState || null; }

  /**
   * 依赖注入：设置后端控制器
   * @param {any} controller
   */
  setController(controller) { this._controller = controller; }

  /**
   * 依赖注入：设置 UI 状态
   * @param {any} uiState
   */
  setUIState(uiState) { this._uiState = uiState; }


  // 兼容访问器：优先使用注入的 controller/uiState，不存在时回退全局
  get controller() { return this._controller || window.backendController || window.ResponseLinter?.BackendController || null; }
  get uiState() { return this._uiState || window.UIState || window.ResponseLinter?.UIState || null; }

  /**
   * 静态初始化方法
   * 创建全局实例并设置向后兼容性
   */
  static async initialize() {
    try {
      console.log('🔍 初始化ValidationFunctionsUI...');

      // 创建实例
      const validationFunctionsInstance = new ValidationFunctionsUI();

      // 设置到全局命名空间
      if (!window.ResponseLinter) {
        window.ResponseLinter = {};
      }
      window.ResponseLinter.ValidationFunctions = validationFunctionsInstance;

      // 向后兼容：在全局scope创建ValidationFunctions（保持现有代码工作）
      window.ValidationFunctions = validationFunctionsInstance;

      validationFunctionsInstance.isInitialized = true;
      console.log('✅ ValidationFunctionsUI初始化完成，向后兼容性已建立');
    } catch (error) {
      console.error('❌ ValidationFunctionsUI初始化失败:', error);
      throw error;
    }
  }

  /**
   * 手动触发验证
   */
  triggerManualValidation() {
    try {
      // 检查后端控制器是否可用
      const backendController = this.controller;

      if (!backendController) {
        console.warn('后端控制器未初始化');
        if (window.toastr) {
          window.toastr.warning('验证系统未就绪，请检查扩展是否正确加载', '响应检查器');
        }
        return;
      }

      const result = backendController.validateLatestMessage();

      if (!result) {
        if (window.toastr) {
          window.toastr.warning('没有找到可验证的AI消息', '响应检查器');
        }
        return;
      }

      if (result.isValid) {
        const extensionName = 'response-linter';
        if (window.extension_settings &&
            window.extension_settings[extensionName] &&
            window.extension_settings[extensionName].notifications.showSuccess) {
          if (window.toastr) {
            window.toastr.success('最新消息验证通过', '响应检查器');
          }
        }
      } else {
        this.showDetailedValidationNotification(result);
      }

      // 更新统计显示
      if (this.uiState) {
        this.uiState.updateStatistics();
      }
    } catch (error) {
      console.error('手动验证失败:', error);
      if (window.toastr) {
        window.toastr.error('验证过程出错', '响应检查器');
      }
    }
  }

  /**
   * 显示详细验证失败通知
   * @param {Object} result - 验证结果对象
   */
  showDetailedValidationNotification(result) {
    try {
      if (!window.extension_settings || !window.toastr) {
        console.warn('必需的全局对象未初始化');
        return;
      }

      const extensionName = 'response-linter';
      const duration = window.extension_settings[extensionName].notifications.duration * 1000;
      const hasAutoFix = result.fixStrategy && this.uiState && this.uiState.isAutoFixEnabled;

      // 生成详细错误信息HTML
      const detailsHtml = this.generateErrorDetailsHtml(result);

      let message = `<div class="rl-validation-error-detail">
                       <div class="rl-error-type">
                         规则验证失败：<strong>${result.ruleName}</strong>


                         ${this.getErrorBadgeHtml(result.errorType)}
                       </div>
                       ${detailsHtml}
                     </div>`;

      const options = {
        timeOut: duration,
        extendedTimeOut: duration + 2000,
        closeButton: true,
        escapeHtml: false,
      };

      // 按设置决定 toast 点击行为：preview 或 apply
      const defaultAction = (window.extension_settings?.[extensionName]?.defaultAutoFixAction) || 'apply';
      if (defaultAction === 'preview') {
        options.onclick = () => this.previewAutoFix();
      } else if (hasAutoFix) {
        options.onclick = () => this.triggerAutoFix(result.ruleName);
      }

      if (hasAutoFix) {
        message += '<br><em>点击进行自动修复</em>';
        // 附加一个“预览修复”链接，便于用户先看效果
        message += ' <a href="#" class="rl-preview-link" style="margin-left:8px;">预览修复</a>';
        options.title = '⚠️ 可自动修复';
      } else {
        options.title = this.getErrorTitle(result.errorType);
      }

      // 监听“预览修复”点击（toastr 渲染后绑定一次性事件）
      setTimeout(() => {
        try {
          $(document)
            .off('click.rl-preview', '.rl-preview-link')
            .on('click.rl-preview', '.rl-preview-link', (e) => {
              e.preventDefault();
              this.previewAutoFix();
            });
        } catch {}
      }, 0);

      window.toastr.warning(message, options.title, options);
    } catch (error) {
      console.error('显示验证通知失败:', error);
    }
  }

  /**
   * 生成错误类型徽章HTML
   * @param {string} errorType - 错误类型
   * @returns {string} 徽章HTML
   */
  getErrorBadgeHtml(errorType) {
    const badges = {
      missing: '<span class="rl-error-badge missing">标签缺失</span>',
      order: '<span class="rl-error-badge order">顺序错误</span>',
      incomplete: '<span class="rl-error-badge incomplete">不完整配对</span>',
    };

    return badges[errorType] || '<span class="rl-error-badge missing">验证失败</span>';
  }

  /**
   * 获取错误标题
   * @param {string} errorType - 错误类型
   * @returns {string} 错误标题
   */
  getErrorTitle(errorType) {
    const titles = {
      missing: '⚠️ 缺失必需标签',
      order: '⚠️ 标签顺序错误',
      incomplete: '⚠️ 标签配对不完整',
    };

    return titles[errorType] || '⚠️ 检测到格式问题';
  }

  /**
   * 生成详细错误信息HTML
   * @param {Object} result - 验证结果对象
   * @returns {string} 错误详情HTML
   */
  generateErrorDetailsHtml(result) {
    try {
      if (!result.errorDetails || result.errorDetails.length === 0) {
        // 向后兼容：如果没有详细错误信息，使用简单格式（对标签做HTML转义，避免被浏览器吞掉）
        const esc = s => String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
        const missingEsc = Array.isArray(result.missingContent) ? result.missingContent.map(esc).join(', ') : '';
        return `<div class="rl-error-position">
                  <strong>缺失内容：</strong>${missingEsc}
                </div>`;
      }

      let html = '';

      for (const detail of result.errorDetails) {
        if (detail.type === 'missing') {
          const esc = s => String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
          html += `<div class="rl-error-position">
                     <strong>缺失标签：</strong><span class="rl-error-code">${esc(detail.item)}</span>
                   </div>
                   <div class="rl-suggested-fix">
                     <strong>修复建议：</strong>${esc(detail.suggestedFix)}
                   </div>`;
        } else if (detail.type === 'order') {
          html += `<div class="rl-error-position">
                     <strong>位置错误：</strong>${detail.message}
                   </div>
                   <div class="rl-suggested-fix">
                     <strong>修复建议：</strong>${detail.suggestedFix}
                   </div>`;
        }
      }

      return html;
    } catch (error) {
      console.error('生成错误详情HTML失败:', error);
      return '<div class="rl-error-position">生成错误详情时出错</div>';
    }
  }

  /**
   * 兼容原有的简单通知方法（废弃）
   * @param {string} ruleName - 规则名称
   * @param {Array} missingContent - 缺失内容数组
   * @param {string} fixStrategy - 修复策略
   * @deprecated 建议使用showDetailedValidationNotification
   */
  showValidationNotification(ruleName, missingContent, fixStrategy) {
    console.warn('showValidationNotification已废弃，请使用showDetailedValidationNotification');

    try {
      if (!window.extension_settings || !window.toastr) {
        console.warn('必需的全局对象未初始化');
        return;
      }

      const extensionName = 'response-linter';
      const duration = window.extension_settings[extensionName].notifications.duration * 1000;
      const hasAutoFix = fixStrategy && this.uiState && this.uiState.isAutoFixEnabled;

      let message = `<strong>验证失败</strong><br>
                        规则：${ruleName}<br>
                        缺失：${missingContent.join(', ')}`;

      const options = {
        timeOut: duration,
        extendedTimeOut: duration + 2000,
        closeButton: true,
        escapeHtml: false,
        onclick: hasAutoFix ? () => this.triggerAutoFix(ruleName) : null,
      };

      if (hasAutoFix) {
        message += '<br><br><em>点击进行自动修复</em>';
        options.title = '⚠️ 可自动修复';
      } else {
        options.title = '⚠️ 检测到格式问题';
      }

      window.toastr.warning(message, options.title, options);
    } catch (error) {
      console.error('显示简单验证通知失败:', error);
    }
  }

  /**
   * 触发自动修复
   * @param {string} ruleName - 规则名称
   */
  async triggerAutoFix(ruleName) {
    try {
      console.log('触发自动修复功能:', ruleName);

      // 检查后端控制器是否可用
      const backendController = this.controller;

      if (!backendController) {
        console.warn('后端控制器未初始化，无法执行自动修复');
        if (window.toastr) {
          window.toastr.warning('修复系统未就绪', '响应检查器');
        }
        return;
      }

      // 调用后端控制器的自动修复功能
      const latest = backendController.getLatestAIMessage();
      if (!latest) { window.toastr?.warning('没有找到AI消息', '响应检查器'); return; }
      const result = await backendController.triggerManualFix(latest.id);
      if (!result.success && !result.metadata?.requiresConfirmation) {
        window.toastr?.warning(result.reason || '无法修复当前消息', '响应检查器');
      }
    } catch (error) {
      console.error('触发自动修复失败:', error);
      if (window.toastr) {
        window.toastr.error('自动修复触发失败', '响应检查器');
      }
    }
  }

  /**
   * 预览自动修复：不写回消息，仅展示差异
   */
  async previewAutoFix() {
    try {
      const backendController = this.controller;
      if (!backendController) { window.toastr?.warning('系统未就绪', '响应检查器'); return; }
      const preview = backendController.previewLatestFix();
      if (!preview.success) { window.toastr?.info(preview.reason || '没有可预览的修复', '响应检查器'); return; }

      // 弹窗展示差异（简单并排展示，保持最小侵入）
      const html = $(`
        <div class="rl-preview-diff">
          <h3>修复预览（不修改原消息）</h3>
          <div class="grid-two">
            <div>
              <h4>原始内容</h4>
              <pre style="max-height:300px;overflow:auto;white-space:pre-wrap;">${$('<div>').text(preview.originalContent).html()}</pre>
            </div>
            <div>
              <h4>修复后内容</h4>
              <pre style="max-height:300px;overflow:auto;white-space:pre-wrap;">${$('<div>').text(preview.newContent).html()}</pre>
              <div style="margin-top:8px;">
                <button class="menu_button small rl-copy-fixed">复制修复后内容</button>
              </div>
            </div>
          </div>
        </div>
      `);
      html.on('click', '.rl-copy-fixed', () => {
        try { navigator.clipboard?.writeText(preview.newContent); window.toastr?.success('已复制', '响应检查器'); } catch {}
      });

      const popup = (window.getContext && getContext().callGenericPopup) ? getContext().callGenericPopup : window.callGenericPopup;
      await popup?.(html, 'display', '修复预览', { allowVerticalScrolling: true });
    } catch (e) {
      console.error('预览自动修复失败', e);
      window.toastr?.error('预览失败', '响应检查器');
    }
  }

}

// 导出单例模式的便捷访问方法
export function getValidationFunctions() {
  return window.ValidationFunctions || window.ResponseLinter?.ValidationFunctions;
}
