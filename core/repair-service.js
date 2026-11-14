// 手动 / 自动 / 预览共用的修复规划层。
// 普通规则修复先沿用既有 AutoFixEngine 流程，再对结果应用两个可选结构清理；
// 最后只由 messageModifier 写入，避免两条路径产生不同结果或重复写入。
import { autoFixEngine } from './auto-fix-engine.js';
import { validationEngine } from './validation-engine.js';
import { resolveCalendarSource } from './calendar-engine.js';
import { readFeatureSettings } from './feature-settings.js';
import {
  findMessage,
  getFreshContext,
  isStreamingContext,
  messageContent,
  messageSwipeId,
} from './host-context.js';
import { sanitizeLeakedReasoning } from './reasoning-sanitizer.js';
import {
  buildProfileAnchorPatterns,
  readStructureProfiles,
} from './structure-profiles.js';
import { repairWithProfile } from './structure-repair.js';

export const FEATURE_STRATEGIES = Object.freeze({
  reasoning: 'remove-leaked-reasoning',
  boundary: 'sdc-content-boundary',
  detailsOrder: 'details-outside-content-order',
});

export function normalizeRepairSettings(raw) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const feature = readFeatureSettings(settings);
  return {
    removeLeakedReasoning: feature.removeLeakedReasoning,
    repairSdcBoundary: feature.repairSdcBoundary,
    repairDetailsOrder: feature.repairDetailsOrder,
    detailsMonologueKeyword: feature.detailsMonologueKeyword,
    detailsChoicesKeyword: feature.detailsChoicesKeyword,
    calendarSource: feature.sdcCalendarSource,
    customCalendarJson: feature.sdcCustomCalendarJson,
    advanceMinutes: feature.sdcAdvanceMinutes,
    raw: settings,
  };
}

export function hasEnabledFeature(settings) {
  const normalized = normalizeRepairSettings(settings);
  return normalized.removeLeakedReasoning || normalized.repairSdcBoundary || normalized.repairDetailsOrder;
}

function hasAnyStructureFeature(normalized) {
  return normalized.removeLeakedReasoning || normalized.repairSdcBoundary || normalized.repairDetailsOrder;
}

/**
 * 对单段文本应用两个独立清理开关。不读写宿主，只做纯文本转换。
 */
export function transformContent(content, settings, ctx = null) {
  const normalized = normalizeRepairSettings(settings);
  const original = typeof content === 'string' ? content : String(content ?? '');
  let current = original;
  const strategies = [];
  const warnings = [];
  const details = {};
  const profileCollection = readStructureProfiles(settings);
  const profile = profileCollection.activeProfile;

  if (normalized.removeLeakedReasoning) {
    const reasoning = sanitizeLeakedReasoning(current, {
      anchorPatterns: buildProfileAnchorPatterns(profile),
      useDefaultAnchorPatterns: false,
    });
    details.reasoning = reasoning;
    if (reasoning.warnings.length) warnings.push(...reasoning.warnings);
    if (reasoning.changed) {
      current = reasoning.content;
      strategies.push(FEATURE_STRATEGIES.reasoning);
    }
  }

  let calendarResult = null;
  if (normalized.repairSdcBoundary || normalized.repairDetailsOrder) {
    // One shared profile-driven pass. The calendar resolver is lazy: it is only
    // called when a missing end marker needs synthesis, never for time mode
    // none or for moving an existing marker.
    let resolved = null;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = resolveCalendarSource({
          source: normalized.calendarSource,
          customJson: normalized.customCalendarJson,
          ctx,
        });
      }
      return resolved;
    };
    const structure = repairWithProfile(current, profile, {
      bodyBoundaryEnabled: normalized.repairSdcBoundary,
      trailingOrderEnabled: normalized.repairDetailsOrder,
      resolveCalendar: resolveOnce,
      advanceMinutes: normalized.advanceMinutes,
      source: normalized.calendarSource,
    });
    if (normalized.repairSdcBoundary && structure.boundary) details.boundary = structure.boundary;
    if (normalized.repairDetailsOrder && structure.trailing) details.detailsRepair = structure.trailing;
    if (resolved) {
      calendarResult = resolved;
      details.calendar = resolved;
      if (!resolved.ok) warnings.push(`历法来源不可用：${resolved.error}`);
    }
    if (structure.warnings.length) warnings.push(...structure.warnings);
    if (structure.boundary?.changed) strategies.push(FEATURE_STRATEGIES.boundary);
    if (structure.trailing?.changed) strategies.push(FEATURE_STRATEGIES.detailsOrder);
    if (structure.changed) current = structure.content;
    if (structure.calendarResult) calendarResult = structure.calendarResult;
  }

  return {
    content: current,
    changed: current !== original,
    strategies,
    warnings: [...new Set(warnings)],
    details,
    calendarResult,
    settings: normalized,
    profile,
    profileCollection,
  };
}

function findRule(ruleId) {
  return validationEngine.activeRules.find(rule => rule.id === ruleId) || null;
}

/**
 * 生成一次修复计划。调用方只负责把计划交给 FixCoordinator / messageModifier，
 * 不直接改消息。手动、自动、预览均使用本函数。
 *
 * @param {Object} input
 * @returns {Object} plan
 */
export function buildRepairPlan({
  messageId,
  settings = {},
  ctx = null,
  validation = undefined,
  ruleStrategyOverride = null,
  includeRuleFix = true,
  preview = false,
} = {}) {
  const context = ctx || getFreshContext();
  if (!context) {
    return { success: false, reason: '无法获取酒馆上下文，请刷新或稍后重试。', warnings: [] };
  }
  if (isStreamingContext(context)) {
    return {
      success: false,
      suppressed: true,
      reason: '当前回复仍在流式生成中，已跳过修复，请等待生成完成后重试。',
      warnings: [],
    };
  }
  const found = findMessage(context, messageId);
  if (!found.message) {
    return { success: false, reason: '找不到指定的消息。', warnings: [] };
  }
  const message = found.message;
  if (message.is_user || message.is_system) {
    return { success: false, reason: '只能修复 AI 回复消息。', warnings: [] };
  }
  const content = messageContent(message);
  if (typeof content !== 'string') {
    return { success: false, reason: '消息内容不是文本。', warnings: [] };
  }
  const swipeId = messageSwipeId(message);
  const normalized = normalizeRepairSettings(settings);

  let ruleValidation = validation;
  if (ruleValidation === undefined && includeRuleFix) {
    ruleValidation = validationEngine.validateMessage(content, messageId) || null;
  }
  let fixedContent = content;
  let appliedRuleFix = false;
  const strategies = [];
  const warnings = [];
  let ruleId = ruleValidation?.metadata?.ruleId || null;
  let rule = ruleId ? findRule(ruleId) : null;
  let ruleReason = null;

  if (includeRuleFix && ruleValidation && !ruleValidation.isValid) {
    const strategy = ruleStrategyOverride !== null && ruleStrategyOverride !== undefined
      ? ruleStrategyOverride
      : ruleValidation.fixStrategy;
    if (!strategy) {
      if (!hasAnyStructureFeature(normalized)) {
        return { success: false, reason: '此规则未配置修复策略，未修改消息。', warnings, messageId, swipeId };
      }
      warnings.push('普通规则未配置修复策略；本次只执行已启用的结构清理。');
    } else {
      // 与既有的自动修复事件路径保持一致：顺序错误时把“应在其后”的结束标签
      // 也视作待补项，避免 1.4.5 已支持的顺序修复在 1.4.6 退化。
      let missingItems = Array.isArray(ruleValidation.missingContent) ? [...ruleValidation.missingContent] : [];
      if (ruleValidation.errorType === 'order' && Array.isArray(ruleValidation.errorDetails)) {
        const synthesized = ruleValidation.errorDetails
          .filter(detail => detail && detail.type === 'order' && typeof detail.expectedAfter === 'string' && /^<\//.test(detail.expectedAfter))
          .map(detail => detail.expectedAfter);
        if (synthesized.length) missingItems = [...new Set([...missingItems, ...synthesized])];
      }
      const previousEnabled = autoFixEngine.isEnabled;
      const previousRule = window.ResponseLinter?.CurrentRule;
      try {
        window.ResponseLinter = window.ResponseLinter || {};
        if (rule) window.ResponseLinter.CurrentRule = rule;
        if (!autoFixEngine.isEnabled) autoFixEngine.setEnabled(true);
        const fixResult = autoFixEngine.attemptFix(fixedContent, missingItems, strategy);
        if (fixResult.success && fixResult.fixedContent !== fixedContent) {
          fixedContent = fixResult.fixedContent;
          appliedRuleFix = true;
          strategies.push(fixResult.strategy);
        } else if (!fixResult.success) {
          ruleReason = fixResult.metadata?.reason || '没有适用的修复策略';
          if (!hasAnyStructureFeature(normalized)) {
            return { success: false, reason: ruleReason, warnings, messageId, swipeId };
          }
          warnings.push(`普通规则修复失败（${ruleReason}）；继续执行结构清理。`);
        }
      } finally {
        autoFixEngine.setEnabled(previousEnabled);
        if (window.ResponseLinter) window.ResponseLinter.CurrentRule = previousRule;
      }
    }
  }

  const feature = transformContent(fixedContent, settings, context);
  if (feature.warnings.length) warnings.push(...feature.warnings);
  if (feature.changed) {
    fixedContent = feature.content;
    strategies.push(...feature.strategies);
  }

  if (appliedRuleFix && ruleValidation && !feature.changed) {
    const currentRule = rule || findRule(ruleId);
    if (currentRule) {
      const after = validationEngine._validateSingleRule(fixedContent, currentRule, messageId);
      if (!after.isValid) {
        return {
          success: false,
          reason: '修复后仍不满足当前规则，未修改消息。',
          warnings,
          messageId,
          swipeId,
          content,
          fixedContent,
        };
      }
    }
  } else if (ruleValidation && !ruleValidation.isValid && feature.changed) {
    const currentRule = rule || findRule(ruleId);
    if (currentRule) {
      const after = validationEngine._validateSingleRule(fixedContent, currentRule, messageId);
      if (!after.isValid) warnings.push('结构清理后仍未满足普通规则；这是规则与清理目标可能冲突造成的，请检查规则配置。');
    }
  }

  if (fixedContent === content) {
    const reason = feature.warnings.length
      ? feature.warnings[0]
      : (ruleValidation?.isValid ? '消息已通过验证，无需修复。' : (ruleReason || '未发现可修复的问题。'));
    return {
      success: false,
      changed: false,
      reason,
      warnings: [...new Set(warnings)],
      messageId: found.resolvedId,
      swipeId,
      content,
      fixedContent: content,
      strategies: [],
      calendarResult: feature.calendarResult,
      featureDetails: feature.details,
    };
  }

  return {
    success: true,
    changed: true,
    messageId: found.resolvedId,
    swipeId,
    content,
    fixedContent,
    strategy: strategies.join(' | ') || (
      normalized.removeLeakedReasoning
        ? FEATURE_STRATEGIES.reasoning
        : (normalized.repairSdcBoundary
          ? FEATURE_STRATEGIES.boundary
          : (normalized.repairDetailsOrder ? FEATURE_STRATEGIES.detailsOrder : FEATURE_STRATEGIES.boundary))
    ),
    strategies,
    warnings: [...new Set(warnings)],
    ruleId,
    ruleName: rule?.name || null,
    ruleValidation,
    message,
    featureChanged: feature.changed,
    calendarResult: feature.calendarResult,
    featureDetails: feature.details,
    settings: normalized,
  };
}
