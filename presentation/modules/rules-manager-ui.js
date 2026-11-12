// Response Linter 规则管理器UI模块
// 重构自index.js中的RulesManager对象，保持完全向后兼容

/**
 * 规则管理器UI类
 * 负责规则的渲染、添加、编辑、删除等UI操作
 */
export class RulesManagerUI {
  constructor() {
    // 初始化时可以设置一些内部状态
    this.isInitialized = false;

    // 依赖注入（可选）：后端控制器与 UI 状态
    this._controller = null;
    this._uiState = null;

    /**
     * 为未来替换 window.* 做准备的 setter
     */
    this.setController = (c) => { this._controller = c; };
    this.setUIState = (s) => { this._uiState = s; };
  }

  /**
   * 静态初始化方法
   * 创建全局实例并设置向后兼容性
   */
  static async initialize() {
    try {
      console.log('📋 初始化RulesManagerUI...');

      // 创建实例
      const rulesManagerInstance = new RulesManagerUI();

      // 兼容访问器：优先使用注入的 controller/uiState
      Object.defineProperty(rulesManagerInstance, 'controller', { get() { return this._controller || window.backendController || window.ResponseLinter?.BackendController || null; } });
      Object.defineProperty(rulesManagerInstance, 'uiState', { get() { return this._uiState || window.UIState || window.ResponseLinter?.UIState || null; } });

      // 设置到全局命名空间
      if (!window.ResponseLinter) {
        window.ResponseLinter = {};
      }
      window.ResponseLinter.RulesManager = rulesManagerInstance;

      // 向后兼容：在全局scope创建RulesManager（保持现有代码工作）
      window.RulesManager = rulesManagerInstance;

      rulesManagerInstance.isInitialized = true;
      console.log('✅ RulesManagerUI初始化完成，向后兼容性已建立');
    } catch (error) {
      console.error('❌ RulesManagerUI初始化失败:', error);
      throw error;
    }
  }

  /**
   * 渲染规则列表
   */
  renderRulesList() {
    try {
      const container = $('#rl-rules-list');
      container.empty();

      // 获取全局UIState中的规则
      const rules = this.uiState ? this.uiState.rules : [];

      rules.forEach(rule => {
        const ruleElement = this.createRuleElement(rule);
        container.append(ruleElement);
      });

      // 更新状态指示器
      if (this.uiState) {
        this.uiState.updateStatusIndicator();
      }
    } catch (error) {
      console.error('渲染规则列表失败:', error);
    }
  }

  /**
   * 从模板创建规则元素
   * @param {Object} rule - 规则对象
   * @returns {jQuery} 规则元素
   */
  createRuleElement(rule) {
    try {
      const template = $('#rl-rule-item-template').prop('content');
      const element = $(template.cloneNode(true));

      element.find('.rl-rule-item').attr('data-rule-id', rule.id);
      element.find('.rl-rule-name').text(rule.name);
      element.find('.rl-rule-description').text(rule.description || '无描述');
      element.find('.rl-rule-enabled').prop('checked', rule.enabled);

      // 添加必需内容标签
      const tagsContainer = element.find('.rl-rule-tags');
      rule.requiredContent.forEach(content => {
        const tag = $(`<span class="rl-tag">${content}</span>`);
        tagsContainer.append(tag);
      // 渲染规则的必需内容摘要（包含 custom 的 pattern/replacement 提示）
      try {
        const tagsBox = element.find('.rl-rule-tags');
        const map = { 'balance-pairs': '配对', 'after-prev': '上后', 'before-next': '下前', 'custom': '自定义' };
        const rc = Array.isArray(rule.requiredContent) ? rule.requiredContent : [];
        tagsBox.empty();
        rc.forEach(tag => {
          const chip = $('<span>').addClass('rl-chip').text(tag);
          tagsBox.append(chip);
          // 附加动作摘要
          const opt = rule.contentOptions?.[tag];
          if (opt && Array.isArray(opt.actions) && opt.actions.length) {
            const actText = opt.actions.map(a => map[a]||a).join('/');
            tagsBox.append($('<small>').addClass('rl-help-text').css('margin-left','4px').text(`(${actText})`));
            if (opt.actions.includes('custom') && (opt.pattern || typeof opt.replacement === 'string')) {
              const extra = ` 正则:${opt.pattern||''}${opt.replacement?` / 替换:${opt.replacement}`:''}`;
              tagsBox.append($('<small>').addClass('rl-help-text').css('margin-left','6px').text(extra));
            }
          }
        });
      } catch (e) { console.warn('渲染规则摘要失败', e); }

      });

      // 应用禁用状态
      if (!rule.enabled) {
        element.find('.rl-rule-item').addClass('disabled');
      }

      return element;
    } catch (error) {
      console.error('创建规则元素失败:', error);
      return $('<div>创建规则元素时出错</div>');
    }
  }

  /**
   * 添加新规则
   * @param {Object} ruleData - 规则数据
   */
  addRule(ruleData) {
    try {
      const newRule = {
        id: 'rule_' + Date.now(),
        name: ruleData.name,
        description: ruleData.description,
        enabled: ruleData.enabled,
        requiredContent: ruleData.requiredContent,
        fixStrategy: ruleData.fixStrategy,
        positionalOptions: ruleData.positionalOptions, // 新增：位置感知选项
        createdAt: new Date().toISOString(),
        customPattern: ruleData.customPattern || '',
        customReplacement: ruleData.customReplacement ?? '',
        contentOptions: ruleData.contentOptions || {}, // 每项内容的修复绑定
      };

      // 添加到全局UIState
      if (this.uiState) {
        this.uiState.rules.push(newRule);
      }

      this.saveRules();
      this.renderRulesList();

      // 显示成功提示
      if (window.toastr) {
        window.toastr.success(`规则"${newRule.name}"添加成功！`, '响应检查器');
      }
    } catch (error) {
      console.error('添加规则失败:', error);
      if (window.toastr) {
        window.toastr.error('添加规则失败', '响应检查器');
      }
    }
  }

  /**
   * 编辑现有规则
   * @param {string} ruleId - 规则ID
   * @param {Object} ruleData - 规则数据
   */
  editRule(ruleId, ruleData) {
    try {
      if (!this.uiState) {
        throw new Error('UIState未初始化');
      }

      const ruleIndex = this.uiState.rules.findIndex(r => r.id === ruleId);
      if (ruleIndex !== -1) {
        this.uiState.rules[ruleIndex] = {
          ...this.uiState.rules[ruleIndex],
          name: ruleData.name,
          description: ruleData.description,
          enabled: ruleData.enabled,
          requiredContent: ruleData.requiredContent,
          fixStrategy: ruleData.fixStrategy,
          positionalOptions: ruleData.positionalOptions, // 新增：保存位置感知选项
          customPattern: ruleData.customPattern || '',
          customReplacement: ruleData.customReplacement ?? '',
          contentOptions: ruleData.contentOptions || this.uiState.rules[ruleIndex].contentOptions || {},
          updatedAt: new Date().toISOString(),
        };

        this.saveRules();
        this.renderRulesList();

        if (window.toastr) {
          window.toastr.success(`规则"${ruleData.name}"更新成功！`, '响应检查器');
        }
      }
    } catch (error) {
      console.error('编辑规则失败:', error);
      if (window.toastr) {
        window.toastr.error('编辑规则失败', '响应检查器');
      }
    }
  }

  /**
   * 删除规则
   * @param {string} ruleId - 规则ID
   */
  deleteRule(ruleId) {
    try {
      if (!this.uiState) {
        throw new Error('UIState未初始化');
      }

      const rule = this.uiState.rules.find(r => r.id === ruleId);
      if (rule) {
        this.uiState.rules = this.uiState.rules.filter(r => r.id !== ruleId);
        this.saveRules();
        this.renderRulesList();

        if (window.toastr) {
          window.toastr.info(`规则"${rule.name}"已删除`, '响应检查器');
        }
      }
    } catch (error) {
      console.error('删除规则失败:', error);
      if (window.toastr) {
        window.toastr.error('删除规则失败', '响应检查器');
      }
    }
  }

  /**
   * 切换规则启用状态
   * @param {string} ruleId - 规则ID
   * @param {boolean} enabled - 启用状态
   */
  toggleRule(ruleId, enabled) {
    try {
      if (!this.uiState) {
        throw new Error('UIState未初始化');
      }

      const rule = this.uiState.rules.find(r => r.id === ruleId);
      if (rule) {
        rule.enabled = enabled;
        this.saveRules();
        this.renderRulesList();
      }
    } catch (error) {
      console.error('切换规则状态失败:', error);
    }
  }

  /**
   * 保存规则到扩展设置（容错增强：动态获取 getContext()）
   */
  async saveRules() {
    try {
      // 允许在 backendController 未就绪时保存；仅当 UIState 和 设置根对象均拿不到时才放弃
      let ctx = null;
      try { ctx = (typeof getContext === 'function') ? getContext() : (window.getContext ? window.getContext() : null); } catch {}
      if (!ctx) {
        try {
          // 优先绝对路径导入 SillyTavern 扩展桥接
          const modAbs = await import('/scripts/extensions.js');
          if (typeof modAbs?.getContext === 'function') ctx = modAbs.getContext();
        } catch (e1) {
          try {
            // 回退相对路径（层级较深时可能无效）
            const modRel = await import('../../../../../../extensions.js');
            if (typeof modRel?.getContext === 'function') ctx = modRel.getContext();
          } catch (e2) {
            /* 忽略：某些环境不允许直接导入，但仍可依赖 window.extension_settings */
          }
        }
      }

      let settingsRoot = ctx?.extensionSettings || window.extension_settings;
      if (!settingsRoot) {
        // 兜底：创建全局扩展设置容器，避免空引用
        window.extension_settings = window.extension_settings || {};
        settingsRoot = window.extension_settings;
      }
      // 确保 UIState 存在（在部分兼容模式下，模块化未完成时可能为 undefined）
      if (!this.uiState) {
        try {
          if (window.ResponseLinter?.UIState) {
            this._uiState = window.ResponseLinter.UIState;
          } else {
            window.UIState = window.UIState || { rules: [] };
            this._uiState = window.UIState;
          }
        } catch {}
      }

      if (!this.uiState || !settingsRoot) {
        console.warn('[Response Linter] 保存规则失败：UIState 或 扩展设置未就绪');
        return;
      }

      const extensionName = 'response-linter';

      // 禁用项保留在配置中，验证和修复时再过滤。

      // 保存到扩展设置
      settingsRoot[extensionName] = settingsRoot[extensionName] || {};
      const targetSettings = settingsRoot[extensionName];
      targetSettings.rules = Array.isArray(this.uiState.rules) ? this.uiState.rules : [];

      // 镜像到 window.extension_settings，避免引用分叉
      try { if (window.extension_settings) window.extension_settings[extensionName] = targetSettings; } catch {}

      // 同步更新后端规则（若后端尚未就绪则跳过）
      if (this.controller && typeof this.controller.updateSettings === 'function') {
        this.controller.updateSettings(targetSettings);
      }

      // 持久化保存（优先使用 getContext().saveSettingsDebounced）
      const saveFn = ctx?.saveSettingsDebounced || window.saveSettingsDebounced;
      if (typeof saveFn === 'function') {
        saveFn();
      }
    } catch (error) {
      console.error('保存规则失败:', error);
    }
  }

  /**
   * 导出规则为JSON文件
   */
  exportRules() {
    try {
      if (!this.uiState) {
        throw new Error('UIState未初始化');
      }

      const dataStr = JSON.stringify(this.uiState.rules, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);

      const link = document.createElement('a');
      link.href = url;
      link.download = 'response-linter-rules.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      if (window.toastr) {
        window.toastr.success('规则导出成功！', '响应检查器');
      }
    } catch (error) {
      console.error('导出规则失败:', error);
      if (window.toastr) {
        window.toastr.error('导出规则失败', '响应检查器');
      }
    }
  }

  /**
   * 从JSON文件导入规则
   */
  importRules() {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';

      input.onchange = event => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = e => {
          try {
            const importedRules = JSON.parse(e.target.result);
            if (Array.isArray(importedRules)) {
              // 分配新ID以避免冲突
              importedRules.forEach(rule => {
                rule.id = Date.now() + Math.random();
                if (this.uiState) {
                  this.uiState.rules.push(rule);
                }
              });

              this.saveRules();
              this.renderRulesList();

              if (window.toastr) {
                window.toastr.success(`成功导入 ${importedRules.length} 条规则！`, '响应检查器');
              }
            } else {
              throw new Error('无效的规则文件格式');
            }
          } catch (error) {
            console.error('导入规则失败:', error);
            if (window.toastr) {
              window.toastr.error('导入失败：' + error.message, '响应检查器');
            }
          }
        };

        reader.readAsText(file);
      };

      input.click();
    } catch (error) {
      console.error('导入规则失败:', error);
      if (window.toastr) {
        window.toastr.error('导入规则失败', '响应检查器');
      }
    }
  }

  /**
   * 添加预设规则模板
   * @param {string} templateType - 模板类型
   */
  addTemplate(templateType) {
    try {
      const templates = {
        thinking: {
          name: '思维链验证',
          description: '验证AI回复包含正确的思考过程和内容格式',
          requiredContent: ['<thinking>', '</thinking>', '<content>', '</content>'],
          fixStrategy: 'positional',
          positionalOptions: { doubleNewline: true },
          enabled: true,
        },
        code: {
          name: '代码块验证',
          description: '验证代码回复包含正确的代码块标记',
          requiredContent: ['```', '```'],
          fixStrategy: 'add-missing-tags',
          enabled: true,
        },
        qa: {
          name: '问答格式验证',
          description: '验证问答回复包含问题和答案部分',
          requiredContent: ['## 问题', '## 答案'],
          fixStrategy: 'positional',
          positionalOptions: { doubleNewline: true },
          enabled: true,
        },
      };

      const template = templates[templateType];
      if (!template) {
        if (window.toastr) {
          window.toastr.error('未知的模板类型', '响应检查器');
        }
        return;
      }

      // 检查是否已存在相同名称的规则
      if (window.UIState) {
        const existingRule = window.UIState.rules.find(rule => rule.name === template.name);
        if (existingRule) {
          if (window.toastr) {
            window.toastr.warning('该模板规则已存在', '响应检查器');
          }
          return;
        }
      }

      // 创建新规则
      const newRule = {
        id: Date.now() + Math.random(),
        ...template,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (window.UIState) {
        window.UIState.rules.push(newRule);
      }

      this.saveRules();
      this.renderRulesList();

      if (window.toastr) {
        window.toastr.success(`成功添加"${template.name}"模板规则！`, '响应检查器');
      }
    } catch (error) {
      console.error('添加模板失败:', error);
      if (window.toastr) {
        window.toastr.error('添加模板失败', '响应检查器');
      }
    }
  }
}
