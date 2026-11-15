// Manual / automatic / preview repair planner for structure-repair features.
// The 1.4.10 production path never reads or executes generic validation rules,
// rule templates, wizards or the old auto-fix strategy engine. Only the three
// structure switches and the active reply-structure profile are considered.
import { resolveCalendarSource } from './calendar-engine.js';
import { readFeatureSettings } from './feature-settings.js';
import {
  findMessage,
  getFreshContext,
  isStreamingContext,
  messageContent,
  messageSwipeId,
  snapshotMessage,
  captureAutoTarget,
  isCurrentAutoTarget,
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

/**
 * Apply the enabled structure features to a single string. Pure text transform:
 * host context is only used to resolve the calendar on demand.
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

/**
 * Build the one repair plan used by manual, automatic and preview paths.
 * Legacy options such as validation/ruleStrategyOverride are accepted but
 * deliberately ignored; no generic rule executor is reachable from here.
 */
export function buildRepairPlan({
  messageId,
  settings = {},
  ctx = null,
  automatic = false,
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
  const normalized = normalizeRepairSettings(settings);
  if (!hasEnabledFeature(settings)) {
    return {
      success: false,
      changed: false,
      reason: '未启用任何回复修复功能。',
      warnings: [],
      messageId: String(messageId),
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
  const expectedState = snapshotMessage(message);
  const autoTarget = automatic ? captureAutoTarget(context, message) : null;
  if (automatic && !isCurrentAutoTarget(autoTarget, context)) {
    return { success: false, suppressed: true, reason: '自动修复目标已成为历史消息', warnings: [] };
  }
  const feature = transformContent(content, settings, context);
  const warnings = [...feature.warnings];

  if (feature.content === content) {
    const reason = warnings.length ? warnings[0] : '未发现可修复的问题。';
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
      profile: feature.profile,
    };
  }

  return {
    success: true,
    changed: true,
    messageId: found.resolvedId,
    swipeId,
    content,
    fixedContent: feature.content,
    strategy: feature.strategies.join(' | ') || FEATURE_STRATEGIES.boundary,
    strategies: feature.strategies,
    warnings: [...new Set(warnings)],
    message,
    expectedState,
    autoTarget,
    featureChanged: true,
    calendarResult: feature.calendarResult,
    featureDetails: feature.details,
    profile: feature.profile,
    settings: normalized,
  };
}
