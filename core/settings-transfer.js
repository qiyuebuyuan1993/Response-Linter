// 结构清理/历法设置的导入导出（纯函数，无 DOM/网络/宿主依赖）。
// 导入采用“全有或全无”：任何非法字段都返回错误，调用方不得覆盖之前的有效设置。
import {
  DEFAULT_ADVANCE_MINUTES,
  MAX_ADVANCE_MINUTES,
  parseCustomCalendarConfig,
} from './calendar-engine.js';
import { FEATURE_DEFAULTS, readFeatureSettings } from './feature-settings.js';

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

function keywordOf(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  const text = value.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function validateKeywordPair(monologue, choices) {
  if (monologue === choices) throw new Error('“内心独白”与“你的选择是”标题关键词不能相同');
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
  const detailsMonologueKeyword = keywordOf(
    input.detailsMonologueKeyword,
    FEATURE_DEFAULTS.detailsMonologueKeyword,
    '“内心独白”标题关键词',
  );
  const detailsChoicesKeyword = keywordOf(
    input.detailsChoicesKeyword,
    FEATURE_DEFAULTS.detailsChoicesKeyword,
    '“你的选择是”标题关键词',
  );
  validateKeywordPair(detailsMonologueKeyword, detailsChoicesKeyword);
  return {
    format: STRUCTURE_SETTINGS_FORMAT,
    version: STRUCTURE_SETTINGS_VERSION,
    removeLeakedReasoning: input.removeLeakedReasoning === true,
    repairSdcBoundary: input.repairSdcBoundary === true,
    repairDetailsOrder: input.repairDetailsOrder === true,
    detailsMonologueKeyword,
    detailsChoicesKeyword,
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
    // 旧设置/旧导出缺少新字段时按“关闭 + 默认标题关键词”处理，且不覆盖上次有效值。
    const previousValid = readFeatureSettings(previousFeatures);
    const previousAdvance = safePreviousAdvance(previousValid.sdcAdvanceMinutes);

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
          removeLeakedReasoning: previousValid.removeLeakedReasoning,
          repairSdcBoundary: previousValid.repairSdcBoundary,
          repairDetailsOrder: previousValid.repairDetailsOrder,
          detailsMonologueKeyword: previousValid.detailsMonologueKeyword,
          detailsChoicesKeyword: previousValid.detailsChoicesKeyword,
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
    if (!hasAnyKey(parsed, [
      'removeLeakedReasoning', 'repairSdcBoundary', 'repairDetailsOrder',
      'detailsMonologueKeyword', 'detailsChoicesKeyword',
      'sdcCalendarSource', 'sdcCustomCalendarJson', 'sdcAdvanceMinutes',
    ])) {
      return { ok: false, error: '配置为空或缺少可导入的结构清理/历法/折叠块字段' };
    }
    for (const key of ['removeLeakedReasoning', 'repairSdcBoundary', 'repairDetailsOrder']) {
      if (parsed[key] != null && typeof parsed[key] !== 'boolean') {
        return { ok: false, error: `${key} 必须是布尔值` };
      }
    }
    for (const key of ['detailsMonologueKeyword', 'detailsChoicesKeyword']) {
      if (parsed[key] != null && typeof parsed[key] !== 'string') {
        return { ok: false, error: `${key} 必须是字符串` };
      }
    }

    const source = parsed.sdcCalendarSource != null
      ? sourceOf(parsed.sdcCalendarSource)
      : safePreviousSource(previousValid.sdcCalendarSource);
    let custom;
    if (Object.prototype.hasOwnProperty.call(parsed, 'sdcCustomCalendarJson')) {
      custom = customOf(parsed.sdcCustomCalendarJson);
    } else if (source === 'custom') {
      custom = customOf(previousValid.sdcCustomCalendarJson);
    } else {
      custom = { text: customTextFromPrevious(previousValid), calendar: null };
    }
    if (source === 'custom' && !custom.calendar) throw new Error('选择自定义历法时必须提供有效 JSON');
    const advance = advanceOf(parsed.sdcAdvanceMinutes, previousAdvance, { strictType: true });

    const detailsMonologueKeyword = keywordOf(
      parsed.detailsMonologueKeyword,
      previousValid.detailsMonologueKeyword,
      '“内心独白”标题关键词',
    );
    const detailsChoicesKeyword = keywordOf(
      parsed.detailsChoicesKeyword,
      previousValid.detailsChoicesKeyword,
      '“你的选择是”标题关键词',
    );
    validateKeywordPair(detailsMonologueKeyword, detailsChoicesKeyword);

    return {
      ok: true,
      settings: {
        removeLeakedReasoning: typeof parsed.removeLeakedReasoning === 'boolean'
          ? parsed.removeLeakedReasoning
          : previousValid.removeLeakedReasoning,
        repairSdcBoundary: typeof parsed.repairSdcBoundary === 'boolean'
          ? parsed.repairSdcBoundary
          : previousValid.repairSdcBoundary,
        repairDetailsOrder: typeof parsed.repairDetailsOrder === 'boolean'
          ? parsed.repairDetailsOrder
          : previousValid.repairDetailsOrder,
        detailsMonologueKeyword,
        detailsChoicesKeyword,
        sdcCalendarSource: source,
        sdcCustomCalendarJson: custom.text,
        sdcAdvanceMinutes: advance,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
