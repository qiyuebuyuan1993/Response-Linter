// 结构清理/历法设置的读取与合并（纯函数）。
// 旧设置缺少字段时默认关闭；非法历法输入不覆盖上一次有效值。
import {
  DEFAULT_ADVANCE_MINUTES,
  FOUR_SEASONS_28,
  MAX_ADVANCE_MINUTES,
  parseCustomCalendarConfig,
} from './calendar-engine.js';

export const FEATURE_DEFAULTS = Object.freeze({
  removeLeakedReasoning: false,
  repairSdcBoundary: false,
  sdcCalendarSource: 'gouhua',
  sdcCustomCalendarJson: '',
  sdcAdvanceMinutes: DEFAULT_ADVANCE_MINUTES,
});

export const CUSTOM_CALENDAR_PRESET = Object.freeze({
  kind: 'custom',
  months: FOUR_SEASONS_28.months.map(month => ({ name: month.name, days: month.days })),
  weekdays: [...FOUR_SEASONS_28.weekdayLabels],
  dateFormat: FOUR_SEASONS_28.dateFormat,
});
export const CUSTOM_CALENDAR_PRESET_JSON = JSON.stringify(CUSTOM_CALENDAR_PRESET, null, 2);

/**
 * 显式切到自定义历法时填充可编辑草稿：不覆盖已有草稿/配置；
 * 草稿与已保存配置都为空时，才放入一份有效预设，避免“空白 JSON 立即被重置”的死循环。
 */
export function seedCustomCalendarDraft(draftText, savedCustomJson = '') {
  const draft = typeof draftText === 'string' ? draftText : '';
  if (draft.trim()) return { text: draft, seeded: false, source: 'draft' };
  const saved = typeof savedCustomJson === 'string'
    ? savedCustomJson
    : (savedCustomJson == null ? '' : JSON.stringify(savedCustomJson, null, 2));
  if (saved.trim()) return { text: saved, seeded: false, source: 'saved' };
  return { text: CUSTOM_CALENDAR_PRESET_JSON, seeded: true, source: 'preset' };
}

const SOURCES = ['gouhua', 'four-seasons-28', 'custom'];

export function readFeatureSettings(raw) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const advance = Number(settings.sdcAdvanceMinutes ?? settings.advanceMinutes ?? DEFAULT_ADVANCE_MINUTES);
  return {
    removeLeakedReasoning: settings.removeLeakedReasoning === true || settings.removeReasoning === true,
    repairSdcBoundary: settings.repairSdcBoundary === true ||
      settings.repairSdcContentBoundary === true || settings.repairSdcContent === true,
    sdcCalendarSource: SOURCES.includes(String(settings.sdcCalendarSource ?? settings.calendarSource))
      ? String(settings.sdcCalendarSource ?? settings.calendarSource)
      : FEATURE_DEFAULTS.sdcCalendarSource,
    sdcCustomCalendarJson: typeof settings.sdcCustomCalendarJson === 'string'
      ? settings.sdcCustomCalendarJson
      : (settings.sdcCustomCalendarJson ?? settings.customCalendarJson ?? ''),
    sdcAdvanceMinutes: Number.isInteger(advance) && advance >= 1 && advance <= MAX_ADVANCE_MINUTES
      ? advance
      : FEATURE_DEFAULTS.sdcAdvanceMinutes,
  };
}

/**
 * 把界面值合并到持久化设置；返回 fields 供调用方写回目标对象。
 * 非法自定义 JSON/来源/推进分钟保留 previous 有效值并给出中文警告。
 */
export function mergeFeatureSettings(previousRaw, uiValues = {}) {
  const previous = readFeatureSettings(previousRaw);
  const warnings = [];
  let source = String(uiValues.sdcCalendarSource ?? previous.sdcCalendarSource);
  if (!SOURCES.includes(source)) {
    warnings.push(`未知历法来源「${source}」，已保留上次有效来源。`);
    source = previous.sdcCalendarSource;
  }
  let customJson = previous.sdcCustomCalendarJson;
  if (source === 'custom') {
    const candidate = uiValues.sdcCustomCalendarJson == null
      ? (typeof previous.sdcCustomCalendarJson === 'string' ? previous.sdcCustomCalendarJson : JSON.stringify(previous.sdcCustomCalendarJson))
      : String(uiValues.sdcCustomCalendarJson);
    const parsed = parseCustomCalendarConfig(candidate);
    if (parsed.ok) {
      customJson = candidate.trim();
    } else {
      // 保留上一次有效 JSON，但不把用户选中的“自定义”来源偷偷改回别的来源；
      // 这样 textarea 保持可见，用户可以继续修正草稿。
      warnings.push(`自定义历法暂未保存：${parsed.error} 已保留上次有效配置，当前草稿仍保留在编辑框中。`);
    }
  } else {
    customJson = previous.sdcCustomCalendarJson;
  }
  const advanceRaw = uiValues.sdcAdvanceMinutes == null
    ? previous.sdcAdvanceMinutes
    : Number(uiValues.sdcAdvanceMinutes);
  const advance = Number.isInteger(advanceRaw) && advanceRaw >= 1 && advanceRaw <= MAX_ADVANCE_MINUTES
    ? advanceRaw
    : previous.sdcAdvanceMinutes;
  if (advance !== advanceRaw) warnings.push(`推进分钟需为 1–${MAX_ADVANCE_MINUTES} 的整数，已保留上次有效值。`);

  const fields = {
    removeLeakedReasoning: uiValues.removeLeakedReasoning === true,
    repairSdcBoundary: uiValues.repairSdcBoundary === true,
    sdcCalendarSource: source,
    sdcCustomCalendarJson: typeof customJson === 'string' ? customJson : JSON.stringify(customJson),
    sdcAdvanceMinutes: advance,
  };
  return { fields, warnings, sourceReset: source !== uiValues.sdcCalendarSource };
}
