// 结构清理/历法设置的导入导出（纯函数，无 DOM/网络/宿主依赖）。
// 导入采用“全有或全无”：任何非法字段都返回错误，调用方不得覆盖之前的有效设置。
import {
  DEFAULT_ADVANCE_MINUTES,
  MAX_ADVANCE_MINUTES,
  parseCustomCalendarConfig,
} from './calendar-engine.js';

export const STRUCTURE_SETTINGS_FORMAT = 'response-linter-structure-settings';
export const STRUCTURE_SETTINGS_VERSION = 1;
const SOURCES = ['gouhua', 'four-seasons-28', 'custom'];
const CALENDAR_KEYS = [
  'kind', 'months', 'weekdayCycle', 'weekdayLabels', 'weekdays', 'dateFormat',
  'era', 'displayStyle', 'id', 'revision', 'epochYear', 'epochOrdinal',
  'epochWeekday', 'absoluteCycle', 'title', 'advanceMinutes',
  'leap', 'leapMonth', 'leapMonths', 'leapDay', 'leapDays', 'leapRule',
  'leapRules', 'leapYears', 'leapCycle', 'intercalary', 'intercalaryMonths',
];

function sourceOf(value, fallback = 'gouhua') {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error('历法来源字段必须是字符串');
  if (!SOURCES.includes(value)) throw new Error(`未知历法来源「${value}」`);
  return value;
}

function advanceOf(value, fallback = DEFAULT_ADVANCE_MINUTES, { strictType = false } = {}) {
  if (value == null) return fallback;
  if (strictType && typeof value !== 'number') throw new Error(`推进分钟必须是 1–${MAX_ADVANCE_MINUTES} 的整数`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_ADVANCE_MINUTES) {
    throw new Error(`推进分钟必须是 1–${MAX_ADVANCE_MINUTES} 的整数`);
  }
  return number;
}

function customOf(value) {
  if (value == null || value === '') return { text: '', calendar: null };
  if (typeof value !== 'string' && typeof value !== 'object') throw new Error('自定义历法必须是 JSON 文本或对象');
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const parsed = parseCustomCalendarConfig(text);
  if (!parsed.ok) throw new Error(`自定义历法无效：${parsed.error}`);
  return { text, calendar: parsed.calendar };
}

function customTextFromPrevious(previousFeatures) {
  const value = previousFeatures.sdcCustomCalendarJson;
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return ''; }
}

function hasAnyKey(object, keys) {
  return keys.some(key => Object.prototype.hasOwnProperty.call(object, key));
}

function safePreviousAdvance(value) {
  try { return advanceOf(value); } catch { return DEFAULT_ADVANCE_MINUTES; }
}

function safePreviousSource(value) {
  try { return sourceOf(value, 'gouhua'); } catch { return 'gouhua'; }
}

export function createStructureSettingsExport(input = {}) {
  const source = sourceOf(input.sdcCalendarSource, 'gouhua');
  const custom = customOf(input.sdcCustomCalendarJson);
  if (source === 'custom' && !custom.calendar) throw new Error('选择自定义历法时必须提供有效 JSON');
  return {
    format: STRUCTURE_SETTINGS_FORMAT,
    version: STRUCTURE_SETTINGS_VERSION,
    removeLeakedReasoning: input.removeLeakedReasoning === true,
    repairSdcBoundary: input.repairSdcBoundary === true,
    sdcCalendarSource: source,
    // 保留用户原始合法 JSON，不能把校验时补出的 advanceMinutes 等默认值写回去。
    sdcCustomCalendarJson: custom.text || '',
    sdcAdvanceMinutes: advanceOf(input.sdcAdvanceMinutes),
  };
}

export function importStructureSettingsText(text, previous = {}) {
  if (typeof text !== 'string') return { ok: false, error: '导入内容必须是 JSON 文本' };
  if (text.length > 50000) return { ok: false, error: '配置 JSON 过长（最多 50000 字符）' };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { return { ok: false, error: `JSON 解析失败：${error.message}` }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '配置文件必须是 JSON 对象' };
  }

  try {
    const previousFeatures = previous && typeof previous === 'object' ? previous : {};
    const previousAdvance = safePreviousAdvance(previousFeatures.sdcAdvanceMinutes);

    // 直接粘贴一份自定义历法 JSON（months 等）也应可用。
    if (hasAnyKey(parsed, CALENDAR_KEYS)) {
      const calendar = parseCustomCalendarConfig(parsed);
      if (!calendar.ok) throw new Error(`自定义历法无效：${calendar.error}`);
      const directAdvance = parsed.advanceMinutes == null
        ? previousAdvance
        : advanceOf(parsed.advanceMinutes, previousAdvance, { strictType: true });
      return {
        ok: true,
        settings: {
          removeLeakedReasoning: previousFeatures.removeLeakedReasoning === true,
          repairSdcBoundary: previousFeatures.repairSdcBoundary === true,
          sdcCalendarSource: 'custom',
          sdcCustomCalendarJson: text.trim(),
          sdcAdvanceMinutes: directAdvance,
        },
      };
    }

    // 设置包装对象：格式/版本/字段类型全部先校验，再返回单个原子结果。
    if (parsed.format != null) {
      if (typeof parsed.format !== 'string' || parsed.format !== STRUCTURE_SETTINGS_FORMAT) {
        return { ok: false, error: '未知配置文件格式' };
      }
    }
    if (parsed.version != null) {
      if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version !== STRUCTURE_SETTINGS_VERSION) {
        return { ok: false, error: `不支持的配置版本：${String(parsed.version)}` };
      }
    }
    if (!hasAnyKey(parsed, ['removeLeakedReasoning', 'repairSdcBoundary', 'sdcCalendarSource', 'sdcCustomCalendarJson', 'sdcAdvanceMinutes'])) {
      return { ok: false, error: '配置为空或缺少可导入的结构清理/历法字段' };
    }
    if (parsed.removeLeakedReasoning != null && typeof parsed.removeLeakedReasoning !== 'boolean') {
      return { ok: false, error: 'removeLeakedReasoning 必须是布尔值' };
    }
    if (parsed.repairSdcBoundary != null && typeof parsed.repairSdcBoundary !== 'boolean') {
      return { ok: false, error: 'repairSdcBoundary 必须是布尔值' };
    }

    const source = parsed.sdcCalendarSource != null
      ? sourceOf(parsed.sdcCalendarSource)
      : safePreviousSource(previousFeatures.sdcCalendarSource);
    let custom;
    if (Object.prototype.hasOwnProperty.call(parsed, 'sdcCustomCalendarJson')) {
      custom = customOf(parsed.sdcCustomCalendarJson);
    } else if (source === 'custom') {
      custom = customOf(previousFeatures.sdcCustomCalendarJson);
    } else {
      custom = { text: customTextFromPrevious(previousFeatures), calendar: null };
    }
    if (source === 'custom' && !custom.calendar) throw new Error('选择自定义历法时必须提供有效 JSON');
    const advance = advanceOf(parsed.sdcAdvanceMinutes, previousAdvance, { strictType: true });

    return {
      ok: true,
      settings: {
        removeLeakedReasoning: typeof parsed.removeLeakedReasoning === 'boolean'
          ? parsed.removeLeakedReasoning
          : previousFeatures.removeLeakedReasoning === true,
        repairSdcBoundary: typeof parsed.repairSdcBoundary === 'boolean'
          ? parsed.repairSdcBoundary
          : previousFeatures.repairSdcBoundary === true,
        sdcCalendarSource: source,
        sdcCustomCalendarJson: custom.text,
        sdcAdvanceMinutes: advance,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
