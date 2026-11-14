// Versioned reply-structure profiles (pure functions, no DOM/host access).
// A profile describes the reply's body pair, optional time-marker templates,
// auxiliary starting markers and ordered trailing block identities. User input
// is never compiled as executable JavaScript or a user-supplied regex.
import {
  DEFAULT_DETAILS_CHOICES_KEYWORD,
  DEFAULT_DETAILS_MONOLOGUE_KEYWORD,
} from './details-repair.js';

export const STRUCTURE_PROFILES_VERSION = 1;
export const LEGACY_PROFILE_ID = 'legacy-sdc-content-details';
export const LEGACY_PROFILE_NAME = '旧版 SDC / content / details';
export const MAX_PROFILES = 40;
export const MAX_PROFILE_BLOCKS = 20;
export const MAX_AUXILIARY_MARKERS = 30;
export const MAX_PROFILE_TEXT = 240;
export const MAX_PROFILE_NAME = 60;
export const MAX_PROFILE_ID = 80;
// A single {date}/{weekday}/{time} capture is a short calendar label, not a
// free-form paragraph. Bounding it keeps malformed markers from making the
// lazy capture scan the entire remaining line.
export const MAX_MARKER_FIELD = 200;

const TIME_MODES = ['none', 'sdc', 'custom'];
const LEGACY_TIME_START = '<!-- SDC-start | date={date} | weekday={weekday} | time={time} -->';
const LEGACY_TIME_END = '<!-- SDC-end | date={date} | weekday={weekday} | time={time} -->';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasForbiddenKey(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12 || value == null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
    if (hasForbiddenKey(value[key], depth + 1, seen)) return true;
  }
  return false;
}

function cleanString(value, maxLength = MAX_PROFILE_TEXT) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function checkText(value, label, maxLength, { required = false } = {}) {
  if (value == null) {
    return required ? { ok: false, error: `${label}不能为空` } : { ok: true, text: '' };
  }
  if (typeof value !== 'string') return { ok: false, error: `${label}必须是字符串` };
  const text = value.replace(/\u0000/g, '').trim();
  if (required && !text) return { ok: false, error: `${label}不能为空` };
  if (text.length > maxLength) return { ok: false, error: `${label}过长（最多 ${maxLength} 字符）` };
  return { ok: true, text };
}

function safeId(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return '';
  const text = value.replace(/\u0000/g, '').trim();
  if (!text || text.length > MAX_PROFILE_ID) return '';
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text) ? text : '';
}

export function isHtmlTagDelimiter(text) {
  return /^<\s*\/?\s*[^\s/>]+\s*(?:\/?\s*)>$/.test(String(text ?? '').trim());
}

export function tagNameOf(text) {
  if (!isHtmlTagDelimiter(text)) return '';
  const match = /^<\s*\/?\s*([^\s/>]+)/.exec(String(text).trim());
  return match ? match[1].toLowerCase() : '';
}

function templateParts(template) {
  const text = String(template ?? '');
  const split = text.split(/(\{date\}|\{weekday\}|\{time\})/);
  return split.filter(part => part !== '').map(part => (
    /^\{(date|weekday|time)\}$/.test(part)
      ? { type: 'placeholder', key: part.slice(1, -1) }
      : { type: 'literal', text: part }
  ));
}

/**
 * Validate a custom marker template. Exactly one of each placeholder is
 * required, both ends must be literal delimiters, adjacent placeholders are
 * rejected (ambiguous), and no unknown placeholders are allowed.
 */
export function validateMarkerTemplate(template) {
  if (typeof template !== 'string') return { ok: false, error: '时间标记模板必须是字符串' };
  const text = template.trim();
  if (!text) return { ok: false, error: '时间标记模板不能为空' };
  if (text.length > MAX_PROFILE_TEXT) return { ok: false, error: '时间标记模板过长' };
  if (/\r|\n/.test(text)) return { ok: false, error: '时间标记模板必须为单行' };
  const unknown = text.match(/\{[^}]+\}/g) || [];
  const allowed = new Set(['{date}', '{weekday}', '{time}']);
  const bad = unknown.find(token => !allowed.has(token));
  if (bad) return { ok: false, error: `时间标记模板包含未知占位符 ${bad}` };
  const counts = { date: 0, weekday: 0, time: 0 };
  for (const token of unknown) counts[token.slice(1, -1)] += 1;
  for (const key of Object.keys(counts)) {
    if (counts[key] !== 1) return { ok: false, error: `时间标记模板必须且只能包含一个 {${key}}` };
  }
  const parts = templateParts(text);
  if (!parts.length || parts[0].type !== 'literal' || parts[parts.length - 1].type !== 'literal') {
    return { ok: false, error: '时间标记模板必须以实际分隔符开头和结尾，避免边界歧义' };
  }
  for (let index = 0; index < parts.length; index++) {
    if (parts[index].type === 'placeholder' && parts[index + 1]?.type === 'placeholder') {
      return { ok: false, error: '两个时间占位符之间必须有实际分隔符，避免无法解析边界' };
    }
  }
  if (!parts.some(part => part.type === 'literal' && part.text.trim())) {
    return { ok: false, error: '时间标记模板需要可辨识的实际分隔符' };
  }
  return { ok: true, parts, text };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a validated template into a RegExp that captures date/weekday/time.
 * Literal text is escaped; there is no user regex execution.
 *
 * Each placeholder is additionally tempered by the literal that follows it:
 * the capture cannot consume that literal's first complete occurrence. This
 * makes malformed input with thousands of repeated delimiters fail at the
 * first boundary instead of backtracking across every delimiter. The per-field
 * bound (MAX_MARKER_FIELD) keeps a missing delimiter from scanning an entire
 * line, and the literal order is exactly the validated template order.
 */
export function compileMarkerTemplate(template, flags = 'g') {
  const checked = validateMarkerTemplate(template);
  if (!checked.ok) return null;
  let source = '';
  for (let index = 0; index < checked.parts.length; index++) {
    const part = checked.parts[index];
    if (part.type === 'literal') {
      source += escapeRegExp(part.text);
      continue;
    }
    // Validation guarantees a literal after every placeholder (no adjacent
    // placeholders, and the template ends with a literal).
    const next = checked.parts[index + 1];
    const boundary = next && next.type === 'literal' ? escapeRegExp(next.text) : '';
    const capture = boundary
      ? `(?:(?!${boundary})[^\\r\\n]){1,${MAX_MARKER_FIELD}}?`
      : `[^\\r\\n]{1,${MAX_MARKER_FIELD}}?`;
    source += `(?<${part.key}>${capture})`;
  }
  try { return new RegExp(source, flags); } catch { return null; }
}

export function buildDelimiterPattern(delimiter, { open = true, capture = false } = {}) {
  const text = String(delimiter ?? '').trim();
  if (!text) return null;
  const tagName = tagNameOf(text);
  if (tagName) {
    return open
      ? `<\\s*${escapeRegExp(tagName)}(?=[\\s/>])[^>]*>`
      : `</\\s*${escapeRegExp(tagName)}\\s*>`;
  }
  return capture ? `(${escapeRegExp(text)})` : escapeRegExp(text);
}

function tagOnly(delimiter) {
  return isHtmlTagDelimiter(delimiter) ? tagNameOf(delimiter) : '';
}

function defaultLegacyKeywords(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const monologue = cleanString(raw.detailsMonologueKeyword, 80) || DEFAULT_DETAILS_MONOLOGUE_KEYWORD;
  const choices = cleanString(raw.detailsChoicesKeyword, 80) || DEFAULT_DETAILS_CHOICES_KEYWORD;
  if (monologue === choices) {
    return {
      monologue: DEFAULT_DETAILS_MONOLOGUE_KEYWORD,
      choices: DEFAULT_DETAILS_CHOICES_KEYWORD,
    };
  }
  return { monologue, choices };
}

/**
 * Built-in legacy profile. Its block order is monologue before choices,
 * matching the actual 1.4.7 behavior when profiles have never been configured.
 */
export function createLegacyProfile(settings = {}) {
  const keywords = defaultLegacyKeywords(settings);
  return {
    version: 1,
    revision: 1,
    id: LEGACY_PROFILE_ID,
    name: LEGACY_PROFILE_NAME,
    builtin: true,
    body: { open: '<content>', close: '</content>' },
    time: { mode: 'sdc', startTemplate: LEGACY_TIME_START, endTemplate: LEGACY_TIME_END },
    auxiliaries: ['<版权水印>', '<details>'],
    // Actual 1.4.7 behavior: when choices precede monologue, swap them into
    // the canonical monologue-then-choices order.
    blocks: [
      {
        id: 'monologue',
        label: '内心独白',
        open: '<details>',
        close: '</details>',
        titleTag: 'summary',
        titleKeyword: keywords.monologue,
      },
      {
        id: 'choices',
        label: '选项',
        open: '<details>',
        close: '</details>',
        titleTag: 'summary',
        titleKeyword: keywords.choices,
      },
    ],
  };
}

/**
 * Strict descriptor normalization used by edits and imports.
 */
export function validateStructureProfile(input, { fallbackId = '', allowMissingId = false } = {}) {
  if (!isPlainObject(input)) return { ok: false, error: '结构配置档案必须是对象' };
  if (hasForbiddenKey(input)) return { ok: false, error: '结构配置档案包含不允许的属性名' };

  const nameCheck = checkText(input.name, '结构配置档案名称', MAX_PROFILE_NAME, { required: true });
  if (!nameCheck.ok) return nameCheck;
  const name = nameCheck.text;
  let id = '';
  if (input.id != null) {
    id = safeId(input.id);
    if (!id) return { ok: false, error: '结构配置档案 id 无效或过长（最多 80 个字母、数字、下划线或连字符）' };
  } else {
    id = safeId(fallbackId);
    if (!id && !allowMissingId) {
      return { ok: false, error: '结构配置档案 id 必须由字母、数字、下划线或连字符组成' };
    }
  }
  const version = input.version == null ? STRUCTURE_PROFILES_VERSION : Number(input.version);
  if (!Number.isInteger(version) || version !== STRUCTURE_PROFILES_VERSION) {
    return { ok: false, error: `不支持的结构配置档案版本：${String(input.version)}` };
  }

  const body = isPlainObject(input.body) ? input.body : {};
  const bodyOpenCheck = checkText(body.open, '正文开始分隔符', MAX_PROFILE_TEXT, { required: true });
  if (!bodyOpenCheck.ok) return bodyOpenCheck;
  const bodyCloseCheck = checkText(body.close, '正文结束分隔符', MAX_PROFILE_TEXT, { required: true });
  if (!bodyCloseCheck.ok) return bodyCloseCheck;
  const bodyOpen = bodyOpenCheck.text;
  const bodyClose = bodyCloseCheck.text;
  if (bodyOpen === bodyClose) return { ok: false, error: '正文开始与结束分隔符不能相同' };
  const bodyOpenTag = tagOnly(bodyOpen);
  const bodyCloseTag = tagOnly(bodyClose);
  if ((isHtmlTagDelimiter(bodyOpen) || isHtmlTagDelimiter(bodyClose)) &&
      (!bodyOpenTag || !bodyCloseTag || bodyOpenTag !== bodyCloseTag)) {
    return { ok: false, error: '正文开始/结束标签必须使用同名成对标签（大小写不敏感）' };
  }

  const timeInput = isPlainObject(input.time) ? input.time : {};
  const mode = String(timeInput.mode ?? 'none').trim().toLowerCase();
  if (!TIME_MODES.includes(mode)) return { ok: false, error: `未知时间模式「${String(timeInput.mode)}」` };
  let startTemplate = '';
  let endTemplate = '';
  if (mode === 'sdc') {
    startTemplate = LEGACY_TIME_START;
    endTemplate = LEGACY_TIME_END;
  } else if (mode === 'custom') {
    const start = validateMarkerTemplate(timeInput.startTemplate);
    const end = validateMarkerTemplate(timeInput.endTemplate);
    if (!start.ok) return { ok: false, error: `开始时间模板无效：${start.error}` };
    if (!end.ok) return { ok: false, error: `结束时间模板无效：${end.error}` };
    if (start.text === end.text) return { ok: false, error: '开始与结束时间模板不能相同' };
    // Reject templates whose generated shapes can match each other. This is a
    // structural ambiguity check, not user regex execution.
    const sampleStart = start.text
      .replace('{date}', '1年夏1日').replace('{weekday}', '周一').replace('{time}', '12:00');
    const sampleEnd = end.text
      .replace('{date}', '1年夏1日').replace('{weekday}', '周一').replace('{time}', '12:00');
    try {
      const startRe = compileMarkerTemplate(start.text, 'i');
      const endRe = compileMarkerTemplate(end.text, 'i');
      if ((startRe && startRe.test(sampleEnd)) || (endRe && endRe.test(sampleStart))) {
        return { ok: false, error: '开始与结束时间模板的边界含糊，可能互相匹配；请加入不同且可辨识的字面分隔符' };
      }
    } catch {
      return { ok: false, error: '无法编译时间标记模板' };
    }
    startTemplate = start.text;
    endTemplate = end.text;
  }
  if (startTemplate && (startTemplate === bodyOpen || startTemplate === bodyClose)) {
    return { ok: false, error: '时间标记模板与正文分隔符冲突' };
  }
  if (endTemplate && (endTemplate === bodyOpen || endTemplate === bodyClose)) {
    return { ok: false, error: '时间标记模板与正文分隔符冲突' };
  }

  const auxiliariesRaw = Array.isArray(input.auxiliaries) ? input.auxiliaries : [];
  if (auxiliariesRaw.length > MAX_AUXILIARY_MARKERS) {
    return { ok: false, error: `辅助外部标记最多 ${MAX_AUXILIARY_MARKERS} 个` };
  }
  const auxiliaries = [];
  const auxSeen = new Set();
  for (const item of auxiliariesRaw) {
    const markerCheck = checkText(item, '辅助外部标记', MAX_PROFILE_TEXT, { required: true });
    if (!markerCheck.ok) return markerCheck;
    const marker = markerCheck.text;
    if (marker === bodyOpen || marker === bodyClose) {
      return { ok: false, error: '辅助外部标记与正文分隔符冲突' };
    }
    if (auxSeen.has(marker)) return { ok: false, error: `辅助外部标记重复：「${marker}」` };
    auxSeen.add(marker);
    auxiliaries.push(marker);
  }

  const blocksRaw = Array.isArray(input.blocks) ? input.blocks : [];
  if (blocksRaw.length > MAX_PROFILE_BLOCKS) {
    return { ok: false, error: `末尾结构块最多 ${MAX_PROFILE_BLOCKS} 个` };
  }
  const blocks = [];
  const ids = new Set();
  const labels = new Set();
  const sameOpen = new Map();
  for (let index = 0; index < blocksRaw.length; index++) {
    const raw = blocksRaw[index];
    if (!isPlainObject(raw)) return { ok: false, error: `第 ${index + 1} 个末尾结构块必须是对象` };
    const suppliedBlockId = raw.id != null ? safeId(raw.id) : '';
    if (raw.id != null && !suppliedBlockId) {
      return { ok: false, error: `第 ${index + 1} 个末尾结构块 id 无效或过长` };
    }
    const blockId = suppliedBlockId || `block-${index + 1}`;
    if (ids.has(blockId)) return { ok: false, error: `末尾结构块 id 重复：「${blockId}」` };
    ids.add(blockId);
    const labelCheck = checkText(raw.label, `第 ${index + 1} 个末尾结构块标签`, 60);
    if (!labelCheck.ok) return labelCheck;
    const label = labelCheck.text || `结构块 ${index + 1}`;
    if (labels.has(label)) return { ok: false, error: `末尾结构块标签重复：「${label}」` };
    labels.add(label);
    const openCheck = checkText(raw.open, `结构块「${label}」的开始分隔符`, MAX_PROFILE_TEXT, { required: true });
    if (!openCheck.ok) return openCheck;
    const closeCheck = checkText(raw.close, `结构块「${label}」的结束分隔符`, MAX_PROFILE_TEXT, { required: true });
    if (!closeCheck.ok) return closeCheck;
    const open = openCheck.text;
    const close = closeCheck.text;
    if (open === close) return { ok: false, error: `结构块「${label}」的开始与结束分隔符不能相同` };
    const openTag = tagOnly(open);
    const closeTag = tagOnly(close);
    if ((isHtmlTagDelimiter(open) || isHtmlTagDelimiter(close)) &&
        (!openTag || !closeTag || openTag !== closeTag)) {
      return { ok: false, error: `结构块「${label}」的开始/结束标签必须同名成对` };
    }
    if (open === bodyOpen || open === bodyClose || close === bodyOpen || close === bodyClose) {
      return { ok: false, error: `结构块「${label}」的分隔符与正文分隔符冲突` };
    }
    const titleTagCheck = checkText(raw.titleTag, `结构块「${label}」的直接标题元素`, 40);
    if (!titleTagCheck.ok) return titleTagCheck;
    const titleKeywordCheck = checkText(raw.titleKeyword, `结构块「${label}」的标题关键词`, 80);
    if (!titleKeywordCheck.ok) return titleKeywordCheck;
    let titleTag = titleTagCheck.text;
    const titleKeyword = titleKeywordCheck.text;
    if (titleTag && /^<[^<>]+>$/.test(titleTag)) {
      titleTag = titleTag.slice(1, -1).trim().toLowerCase();
    }
    if (titleTag && !titleKeyword) return { ok: false, error: `结构块「${label}」填写标题元素时必须填写标题关键词` };
    if (!titleTag && titleKeyword) return { ok: false, error: `结构块「${label}」填写标题关键词时必须填写直接标题元素` };
    if (titleTag && !/^[A-Za-z\u4e00-\u9fff][^\s<>/]*$/.test(titleTag)) {
      return { ok: false, error: `结构块「${label}」的直接标题元素名无效` };
    }
    if (openTag) {
      const prior = sameOpen.get(openTag) || [];
      if (prior.length && !titleTag) {
        return { ok: false, error: `多个结构块共用 <${openTag}>，必须配置直接标题元素与标题关键词以消除歧义` };
      }
      prior.push({ label, titleTag });
      sameOpen.set(openTag, prior);
    } else {
      const prior = sameOpen.get(open);
      if (prior) return { ok: false, error: `字面开始分隔符重复：「${open}」` };
      sameOpen.set(open, [{ label, titleTag }]);
    }
    blocks.push({
      id: blockId,
      label,
      open,
      close,
      titleTag,
      titleKeyword,
    });
  }

  if (blocks.length > 1) {
    for (const [openKey, items] of sameOpen) {
      if (items.length > 1 && !items.every(item => item.titleTag)) {
        return { ok: false, error: `共用分隔符「${openKey}」的结构块必须全部配置直接标题关键词` };
      }
    }
  }
  for (const template of [startTemplate, endTemplate].filter(Boolean)) {
    if (auxiliaries.some(marker => marker === template) ||
        blocks.some(block => block.open === template || block.close === template)) {
      return { ok: false, error: '时间标记模板与辅助标记或结构块分隔符冲突' };
    }
  }

  return {
    ok: true,
    profile: {
      version: STRUCTURE_PROFILES_VERSION,
      revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
      id,
      name,
      builtin: input.builtin === true,
      body: { open: bodyOpen, close: bodyClose },
      time: { mode, startTemplate, endTemplate },
      auxiliaries,
      blocks,
    },
  };
}

/**
 * Lenient runtime reader. Stored corruption falls back to the legacy profile
 * instead of crashing or silently changing an unrelated setting.
 */
export function readStructureProfiles(settings = {}) {
  const raw = isPlainObject(settings) ? settings : {};
  const legacyProfile = createLegacyProfile(raw);
  const hasProfiles = Array.isArray(raw.structureProfiles) && raw.structureProfiles.length > 0;
  const warnings = [];

  if (!hasProfiles) {
    return {
      version: STRUCTURE_PROFILES_VERSION,
      profiles: [legacyProfile],
      activeProfileId: LEGACY_PROFILE_ID,
      activeProfile: legacyProfile,
      legacyProfile,
      migrated: true,
      warnings,
    };
  }

  if (raw.structureProfilesVersion != null &&
      Number(raw.structureProfilesVersion) !== STRUCTURE_PROFILES_VERSION) {
    warnings.push(`不支持的结构配置档案版本 ${String(raw.structureProfilesVersion)}，已使用旧版预设。`);
    return {
      version: STRUCTURE_PROFILES_VERSION,
      profiles: [legacyProfile],
      activeProfileId: LEGACY_PROFILE_ID,
      activeProfile: legacyProfile,
      legacyProfile,
      migrated: false,
      invalid: true,
      warnings,
    };
  }

  if (raw.structureProfiles.length > MAX_PROFILES) {
    warnings.push(`结构配置档案数量超过 ${MAX_PROFILES}，忽略多余项。`);
  }
  const profiles = [];
  const ids = new Set();
  const names = new Set();
  for (const item of raw.structureProfiles.slice(0, MAX_PROFILES)) {
    const result = validateStructureProfile(item, { allowMissingId: false });
    if (!result.ok) {
      warnings.push(`忽略无效结构配置档案：${result.error}`);
      continue;
    }
    if (ids.has(result.profile.id)) {
      warnings.push(`忽略重复 id 的结构配置档案「${result.profile.id}」。`);
      continue;
    }
    if (names.has(result.profile.name)) {
      warnings.push(`忽略同名结构配置档案「${result.profile.name}」。`);
      continue;
    }
    ids.add(result.profile.id);
    names.add(result.profile.name);
    profiles.push(result.profile);
  }
  if (!profiles.length) {
    warnings.push('没有有效的结构配置档案，已回退到旧版预设。');
    profiles.push(legacyProfile);
  }

  // The legacy preset remains tied to the old keyword fields. This keeps the
  // 1.4.6/1.4.7 keyword controls meaningful after migration.
  const existingLegacy = profiles.find(profile => profile.id === LEGACY_PROFILE_ID);
  let effectiveLegacy = legacyProfile;
  if (existingLegacy) {
    effectiveLegacy = validateStructureProfile({
      ...existingLegacy,
      body: legacyProfile.body,
      time: legacyProfile.time,
      auxiliaries: legacyProfile.auxiliaries,
      blocks: existingLegacy.blocks.map(block => {
        if (block.id === 'monologue') return { ...block, titleKeyword: legacyProfile.blocks[0].titleKeyword };
        if (block.id === 'choices') return { ...block, titleKeyword: legacyProfile.blocks[1].titleKeyword };
        return block;
      }),
    }, { fallbackId: LEGACY_PROFILE_ID }).profile || legacyProfile;
  }

  const effectiveProfiles = profiles.map(profile => profile.id === LEGACY_PROFILE_ID ? effectiveLegacy : profile);
  const wanted = typeof raw.structureProfileId === 'string' ? raw.structureProfileId : '';
  let activeProfile = effectiveProfiles.find(profile => profile.id === wanted) || null;
  if (!activeProfile) activeProfile = effectiveProfiles.find(profile => profile.id === LEGACY_PROFILE_ID) || effectiveProfiles[0];
  if (!activeProfile) activeProfile = legacyProfile;
  if (wanted && activeProfile.id !== wanted) {
    warnings.push('当前选中的结构配置档案已失效，已回退到可用档案。');
  }

  return {
    version: STRUCTURE_PROFILES_VERSION,
    profiles: effectiveProfiles,
    activeProfileId: activeProfile.id,
    activeProfile,
    legacyProfile: effectiveLegacy,
    migrated: false,
    warnings,
  };
}

/**
 * Save-time merge. Invalid editor/import data never replaces the previous
 * valid profile list. Draft preservation is the caller's responsibility.
 */
export function mergeStructureProfiles(previousRaw, uiValues = {}) {
  const previous = readStructureProfiles(previousRaw);
  const warnings = [];
  const rawProfiles = uiValues.structureProfiles;
  if (!Array.isArray(rawProfiles) || !rawProfiles.length) {
    warnings.push('结构配置档案列表不能为空，已保留上次有效配置。');
    return { fields: {
      structureProfilesVersion: previous.version,
      structureProfiles: previous.profiles,
      structureProfileId: previous.activeProfileId,
    }, warnings, rejected: true };
  }
  if (rawProfiles.length > MAX_PROFILES) {
    warnings.push(`结构配置档案最多 ${MAX_PROFILES} 个，已保留上次有效配置。`);
    return { fields: {
      structureProfilesVersion: previous.version,
      structureProfiles: previous.profiles,
      structureProfileId: previous.activeProfileId,
    }, warnings, rejected: true };
  }
  const checked = [];
  const ids = new Set();
  const names = new Set();
  for (const item of rawProfiles) {
    const result = validateStructureProfile(item);
    if (!result.ok) {
      warnings.push(`结构配置档案无效：${result.error}，已保留上次有效配置。`);
      return { fields: {
        structureProfilesVersion: previous.version,
        structureProfiles: previous.profiles,
        structureProfileId: previous.activeProfileId,
      }, warnings, rejected: true };
    }
    if (ids.has(result.profile.id)) {
      warnings.push(`结构配置档案 id 重复：「${result.profile.id}」，已保留上次有效配置。`);
      return { fields: {
        structureProfilesVersion: previous.version,
        structureProfiles: previous.profiles,
        structureProfileId: previous.activeProfileId,
      }, warnings, rejected: true };
    }
    if (names.has(result.profile.name)) {
      warnings.push(`结构配置档案名称重复：「${result.profile.name}」，已保留上次有效配置。`);
      return { fields: {
        structureProfilesVersion: previous.version,
        structureProfiles: previous.profiles,
        structureProfileId: previous.activeProfileId,
      }, warnings, rejected: true };
    }
    ids.add(result.profile.id);
    names.add(result.profile.name);
    checked.push(result.profile);
  }
  const wanted = typeof uiValues.structureProfileId === 'string' ? uiValues.structureProfileId.trim() : '';
  const active = checked.find(profile => profile.id === wanted);
  if (!active) {
    warnings.push('选中的结构配置档案不存在，已保留上次有效选择。');
    return { fields: {
      structureProfilesVersion: previous.version,
      structureProfiles: previous.profiles,
      structureProfileId: previous.activeProfileId,
    }, warnings, rejected: true };
  }
  return {
    fields: {
      structureProfilesVersion: previous.version,
      structureProfiles: checked,
      structureProfileId: active.id,
    },
    warnings,
    rejected: false,
  };
}

/**
 * Derive and attach profile fields for old settings without touching any other
 * field. Returns migrated=false when a valid collection/active id already exists.
 */
export function migrateStructureProfileSettings(settings = {}) {
  const raw = isPlainObject(settings) ? settings : {};
  const collection = readStructureProfiles(raw);
  const hasValidProfiles = Array.isArray(raw.structureProfiles) && raw.structureProfiles.length > 0 && !collection.migrated;
  const fields = {};
  let migrated = false;
  if (!hasValidProfiles) {
    fields.structureProfilesVersion = collection.version;
    fields.structureProfiles = collection.profiles;
    fields.structureProfileId = collection.activeProfileId;
    migrated = true;
  } else {
    if (raw.structureProfilesVersion == null) {
      fields.structureProfilesVersion = STRUCTURE_PROFILES_VERSION;
      migrated = true;
    }
    if (typeof raw.structureProfileId !== 'string' ||
        !collection.profiles.some(profile => profile.id === raw.structureProfileId)) {
      fields.structureProfileId = collection.activeProfileId;
      migrated = true;
    }
  }
  return { fields, migrated, collection };
}

export function cloneProfile(profile, { id, name, builtin = false } = {}) {
  const result = validateStructureProfile({
    ...profile,
    id: id || profile.id,
    name: name || profile.name,
    builtin,
  });
  return result.ok ? result.profile : null;
}

export function createBlankProfile({ id, name } = {}) {
  return {
    version: STRUCTURE_PROFILES_VERSION,
    revision: 1,
    id: id || 'custom-profile',
    name: name || '自定义结构',
    builtin: false,
    body: { open: '<content>', close: '</content>' },
    time: { mode: 'none', startTemplate: '', endTemplate: '' },
    auxiliaries: [],
    blocks: [],
  };
}

export function moveProfileBlock(profile, from, to) {
  if (!Array.isArray(profile?.blocks)) return null;
  const indexFrom = Number(from);
  const indexTo = Number(to);
  if (!Number.isInteger(indexFrom) || !Number.isInteger(indexTo)) return null;
  if (indexFrom < 0 || indexFrom >= profile.blocks.length || indexTo < 0 || indexTo >= profile.blocks.length) return null;
  const blocks = profile.blocks.slice();
  const [item] = blocks.splice(indexFrom, 1);
  blocks.splice(indexTo, 0, item);
  return { ...profile, blocks };
}

/**
 * Regex anchors that let reasoning cleanup recognize custom body opens and
 * custom time starts without using fixed <content>/SDC tags.
 */
export function buildProfileAnchorPatterns(profile) {
  const anchors = [];
  if (!profile) return anchors;
  const bodyOpen = profile.body?.open;
  const bodyPattern = buildDelimiterPattern(bodyOpen, { open: true });
  if (bodyPattern) {
    // HTML tag anchors are case-insensitive; literal delimiters stay exact,
    // exactly like the body-boundary finder.
    anchors.push(new RegExp(bodyPattern, isHtmlTagDelimiter(bodyOpen) ? 'gi' : 'g'));
  }
  const mode = profile.time?.mode;
  if (mode === 'sdc') {
    anchors.push(/<!--\s*SDC-start\b/gi);
  } else if (mode === 'custom') {
    const matcher = compileMarkerTemplate(profile.time.startTemplate, 'g');
    if (matcher) anchors.push(matcher);
  }
  return anchors;
}

export function profileMatchesLegacy(profile) {
  return profile?.id === LEGACY_PROFILE_ID;
}

export function describeStructureProfile(profile) {
  if (!profile) return '无结构配置档案';
  const time = profile.time.mode === 'none'
    ? '无时间标记'
    : profile.time.mode === 'sdc'
      ? 'SDC 时间标记'
      : '自定义时间模板';
  return `${profile.name} · 正文 ${profile.body.open}…${profile.body.close} · ${time} · ${profile.blocks.length} 个末尾结构块`;
}
