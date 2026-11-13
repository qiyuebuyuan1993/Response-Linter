// Run: node --test tests/*.mjs (Node.js 24) or node tests/features-1.4.7.mjs
// 1.4.7 正文外折叠块顺序/配对纯转换 + 设置 + 手动/自动/预览/撤销/流式集成测试。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = new EventTarget();
document.createElement = () => ({ textContent: '', get innerHTML() { return this.textContent; } });
globalThis.__testContext = {
  chat: [],
  extensionSettings: {},
  chatMetadata: {},
  streamingProcessor: null,
  saveChat: async () => {},
};
globalThis.getContext = () => globalThis.__testContext;
globalThis.SillyTavern = { getContext };
globalThis.ResponseLinter = {};

const {
  repairDetailsOutsideContent,
  DEFAULT_DETAILS_MONOLOGUE_KEYWORD,
  DEFAULT_DETAILS_CHOICES_KEYWORD,
} = await import('../core/details-repair.js');
const {
  transformContent,
  normalizeRepairSettings,
  hasEnabledFeature,
  FEATURE_STRATEGIES,
} = await import('../core/repair-service.js');
const {
  FEATURE_DEFAULTS,
  readFeatureSettings,
  mergeFeatureSettings,
} = await import('../core/feature-settings.js');
const {
  createStructureSettingsExport,
  importStructureSettingsText,
} = await import('../core/settings-transfer.js');
const { UIStateManager } = await import('../presentation/modules/ui-state-manager.js');
const { messageHandler } = await import('../core/message-handler.js');
const { fixCoordinator } = await import('../core/fix-coordinator.js');
const { messageModifier } = await import('../core/message-modifier.js');
const { createBackendController } = await import('../core/backend-controller.js');
const { escapeHtmlText, joinWarningToasts } = await import('../core/text-safety.js');

const controller = createBackendController('response-linter');
controller.start = () => { controller.isRunning = true; };
fixCoordinator._sleep = async () => {};

const sdcStart = '<!-- SDC-start | date=1年夏5日 | weekday=周五 | time=12:20 -->';
const sdcEnd = '<!-- SDC-end | date=1年夏5日 | weekday=周五 | time=12:30 -->';
const choices = '<details><summary>你的选择是：</summary>\n选项\n</details>';
const monologue = '<details><summary>💭 内心独白 💭</summary>\n独白\n</details>';
const extra = '<details><summary>附加信息</summary>新增末尾块</details>';
const safePrefix = `<content>\n${sdcStart}\n正文\n${sdcEnd}\n</content>\n`;
const safeExternal = after => `${safePrefix}${after}`;

let saves;

function messageFixture(mes, { swipe = mes, extraData = {} } = {}) {
  return { mes, is_user: false, swipe_id: 0, swipes: [swipe], extra: { display_text: mes, ...extraData } };
}

function waitForEvent(name, timeoutMs = 900) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { document.removeEventListener(name, onEvent); reject(new Error(`timeout: ${name}`)); }, timeoutMs);
    const onEvent = event => {
      clearTimeout(timer);
      document.removeEventListener(name, onEvent);
      resolve(event.detail);
    };
    document.addEventListener(name, onEvent);
  });
}

beforeEach(() => {
  assert.equal(fixCoordinator.fixQueue.length, 0);
  fixCoordinator.isProcessing = false;
  fixCoordinator._sleep = async () => {};
  messageModifier.modificationHistory.clear();
  messageModifier.pendingModifications.clear();
  messageHandler.lastContent.clear();
  messageHandler.lastHandledAt.clear();
  messageHandler.retryCounts.clear();
  messageHandler.ctxRef = null;
  __testContext.chat = [];
  __testContext.extensionSettings = {};
  __testContext.chatMetadata = {};
  __testContext.streamingProcessor = null;
  __testContext.updateMessageBlock = async id => { await messageHandler._handleMessageRendered(String(id)); };
  __testContext.saveChat = async () => { saves++; };
  saves = 0;
  globalThis.UIState = { rules: [] };
  controller.resetStatistics();
});

test('两个开关都开：边界先修复，再把两个完整目标块交换到原槽位，末尾新增块不动', () => {
  const extra2 = '<details><summary>页脚</summary>footer</details>';
  const source = `<content>\n${sdcStart}\n正文\n${choices}\n杂项文字（保留在两个目标位置之间）\n${monologue}\n${sdcEnd}\n</content>\n${extra}\n${extra2}`;
  const expected = `${safePrefix}${monologue}\n杂项文字（保留在两个目标位置之间）\n${choices}\n${extra}\n${extra2}`;
  const result = transformContent(source, {
    repairSdcBoundary: true,
    repairDetailsOrder: true,
    sdcCalendarSource: 'four-seasons-28',
    sdcAdvanceMinutes: 10,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.strategies, [FEATURE_STRATEGIES.boundary, FEATURE_STRATEGIES.detailsOrder]);
  assert.equal(result.content, expected);
  assert.equal((result.content.match(new RegExp(sdcEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  const endIndex = result.content.indexOf(sdcEnd);
  const closeIndex = result.content.indexOf('</content>');
  assert.ok(endIndex < closeIndex);
  assert.equal(result.content.slice(endIndex + sdcEnd.length, closeIndex).trim(), '');
  assert.ok(closeIndex < result.content.indexOf(monologue));
  assert.deepEqual(repairDetailsOutsideContent(result.content, {}).changed, false, 'idempotent with safe boundary');
});

test('正确顺序与重复执行均不修改，也不产生目标警告', () => {
  const source = safeExternal(`${monologue}\n${choices}\n${extra}`);
  const first = transformContent(source, { repairDetailsOrder: true });
  assert.equal(first.changed, false);
  assert.equal(first.content, source);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.strategies, []);
  const second = repairDetailsOutsideContent(source, {});
  assert.equal(second.changed, false);
  assert.equal(second.content, source);
  assert.deepEqual(second.warnings, []);
});

test('只开边界修复时不会重排折叠块；只开新开关可在已安全的外部区域工作', () => {
  const source = `<content>\n${sdcStart}\n正文\n${choices}\n杂项\n${monologue}\n${sdcEnd}\n</content>`;
  const boundaryOnly = transformContent(source, {
    repairSdcBoundary: true,
    sdcCalendarSource: 'four-seasons-28',
  });
  assert.equal(boundaryOnly.changed, true);
  assert.deepEqual(boundaryOnly.strategies, [FEATURE_STRATEGIES.boundary]);
  assert.equal(boundaryOnly.details.detailsRepair, undefined);
  assert.ok(boundaryOnly.content.indexOf(choices) < boundaryOnly.content.indexOf(monologue), 'details order untouched');

  // 只开新开关时，必须基于边界修复后已经安全的外部区域；
  // 单独对未修复的原文运行不会隐式移动边界（见下一个用例）。
  const detailsOnly = transformContent(boundaryOnly.content, { repairDetailsOrder: true });
  assert.equal(detailsOnly.changed, true);
  assert.deepEqual(detailsOnly.strategies, [FEATURE_STRATEGIES.detailsOrder]);
  assert.equal(detailsOnly.details.detailsRepair.changed, true);
  assert.ok(detailsOnly.content.indexOf(monologue) < detailsOnly.content.indexOf(choices));
});

test('正文内 HTML 注释中的 details 示例不会被边界修复误判，注释与正文一起留在 content 内', () => {
  const comment = '<!-- 示例 <details><summary>演示</summary>示例</details> -->';
  const commentPrefix = `<content>\n${sdcStart}\n正文结束。\n${comment}\n${sdcEnd}\n</content>\n`;
  const source = commentPrefix + choices + '\n' + monologue;
  const expected = commentPrefix + monologue + '\n' + choices;
  const result = transformContent(source, { repairSdcBoundary: true, repairDetailsOrder: true });
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.content.includes(comment));
  assert.ok(result.content.indexOf(comment) < result.content.indexOf(sdcEnd));
  assert.ok(result.content.indexOf(sdcEnd) < result.content.indexOf('</content>'));
});

test('新开关单独遇到目标块仍在 </content> 之前时警告并跳过，不隐式移动正文边界', () => {
  const source = `<content>\n${sdcStart}\n正文\n${choices}\n${monologue}\n${sdcEnd}\n</content>`;
  const result = transformContent(source, { repairDetailsOrder: true, sdcCalendarSource: 'four-seasons-28' });
  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.ok(result.warnings.some(item => /正文边界/.test(item) && /</.test(item)));
});

test('交换只替换目标槽位：未知块和夹在中间的普通文字逐字节保留', () => {
  const unknown = '<details><summary>未知设定</summary>保留</details>';
  const source = safeExternal(`${choices}\n杂项文字\n${unknown}\n${monologue}\n${extra}`);
  const expected = `${safePrefix}${monologue}\n杂项文字\n${unknown}\n${choices}\n${extra}`;
  const result = repairDetailsOutsideContent(source, {
    monologueKeyword: DEFAULT_DETAILS_MONOLOGUE_KEYWORD,
    choicesKeyword: DEFAULT_DETAILS_CHOICES_KEYWORD,
  });
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.ok(result.repairs.includes('swapped-details-targets'));
  assert.equal(result.content.includes(choices), true);
  assert.equal(result.content.includes(monologue), true);
  assert.equal(result.content.includes(unknown), true);
  assert.equal(result.content.includes('杂项文字'), true);
});

test('缺失 choices 闭合标签时，在可明确判断的并列折叠块前补闭合，再交换', () => {
  const source = safeExternal(`<details><summary>你的选择是：</summary>\n选项\n${monologue}`);
  const expected = `${safePrefix}${monologue}\n<details><summary>你的选择是：</summary>\n选项\n</details>`;
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.deepEqual(result.repairs, ['inserted-details-close', 'swapped-details-targets']);
  assert.equal(result.content.split('</details>').length - 1, 2);
  assert.equal(repairDetailsOutsideContent(result.content, {}).changed, false);

  // 后续完整未知块作为并列兄弟保留，不能被丢弃或改写。
  const withExtras = safeExternal(`<details><summary>你的选择是：</summary>\n选项\n${monologue}\n${extra}\n<details><summary>日志</summary>尾部</details>`);
  const withExtrasExpected = `${safePrefix}${monologue}\n<details><summary>你的选择是：</summary>\n选项\n</details>\n${extra}\n<details><summary>日志</summary>尾部</details>`;
  const withExtrasResult = repairDetailsOutsideContent(withExtras, {});
  assert.equal(withExtrasResult.changed, true);
  assert.equal(withExtrasResult.content, withExtrasExpected);
  assert.deepEqual(withExtrasResult.repairs, ['inserted-details-close', 'swapped-details-targets']);
});

test('未知外层缺少闭合、仅含完整子 details 时不能推断成新兄弟，保留并警告', () => {
  const source = safeExternal(`<details><summary>外层信息</summary>外层正文\n${extra}`);
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.deepEqual(result.repairs, []);
  assert.ok(result.warnings.some(item => /未闭合|归属/.test(item)));
  assert.ok(!result.content.includes('</details>\n<details><summary>附加信息'), 'unknown outer root not flattened');
});

test('完全平衡的嵌套 details 保持不变，不扁平化、不提升嵌套目标标题', () => {
  const nested = `<details><summary>你的选择是：</summary>\n外层\n${monologue}\n</details>`;
  const source = safeExternal(`${nested}\n${extra}`);
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.repairs, []);
});

test('重复目标标题、同时匹配两个关键词、未知标题都保留原文并给出目标歧义警告', () => {
  const duplicate = safeExternal(`<details><summary>内心独白</summary>a</details>\n${monologue}\n${choices}`);
  const duplicateResult = repairDetailsOutsideContent(duplicate, {});
  assert.equal(duplicateResult.changed, false);
  assert.equal(duplicateResult.content, duplicate);
  assert.ok(duplicateResult.warnings.some(item => /重复/.test(item)));

  const both = safeExternal(`<details><summary>内心独白 你的选择是</summary>a</details>\n${choices}`);
  const bothResult = repairDetailsOutsideContent(both, {});
  assert.equal(bothResult.changed, false);
  assert.equal(bothResult.content, both);
  assert.ok(bothResult.warnings.some(item => /同时匹配/.test(item)));

  const unknown = safeExternal(`${choices}\n<details><summary>其他设定</summary>正文中的内心独白不应作为标题</details>`);
  const unknownResult = repairDetailsOutsideContent(unknown, {});
  assert.equal(unknownResult.changed, false);
  assert.equal(unknownResult.content, unknown);
  assert.ok(unknownResult.warnings.some(item => /只识别到一个目标/.test(item)));
});

test('恶意 summary 标签不会进入警告文本，toast 拼接只保留受控 br 并转义 HTML', () => {
  const malicious = '<details><summary><img src=x onerror="alert(1)"> 内心独白 你的选择是</summary>内容</details>';
  const source = safeExternal(`${malicious}\n${choices}`);
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, false);
  assert.equal(result.content, source);
  assert.ok(result.warnings.length);
  assert.ok(result.warnings.every(item => !/<img|onerror|alert/i.test(item)), 'warnings must not echo raw summary markup');
  const joined = joinWarningToasts(result.warnings);
  assert.ok(!joined.includes('<img'));
  assert.equal(escapeHtmlText('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(joinWarningToasts(['<img onerror=1>', '安全文本']), '&lt;img onerror=1&gt;<br>安全文本');
});

test('summary 未闭合/交叉与末尾未闭合块后归属不明文字均只警告并保留原文', () => {
  const malformed = safeExternal(`${choices}\n<details><summary>内心独白 未闭合\n独白</details>`);
  const malformedResult = repairDetailsOutsideContent(malformed, {});
  assert.equal(malformedResult.changed, false);
  assert.equal(malformedResult.content, malformed);
  assert.ok(malformedResult.warnings.some(item => /summary|标题/.test(item)));

  const trailing = safeExternal(`<details><summary>你的选择是：</summary>\n选项\n${monologue}\n归属不明的尾部文字`);
  const trailingResult = repairDetailsOutsideContent(trailing, {});
  assert.equal(trailingResult.changed, false);
  assert.equal(trailingResult.content, trailing);
  assert.ok(trailingResult.warnings.some(item => /未闭合|归属/.test(item)));
  assert.deepEqual(trailingResult.repairs, [], 'no close inserted when trailing text ownership is ambiguous');
});

test('标签大小写、属性、emoji/标点包裹的标题都能识别并交换', () => {
  const choicesAttr = '<details class="choice" data-kind="c"><summary>你的选择是：</summary>\n选项\n</details>';
  const monoAttr = '<DETAILS CLASS="mono"><SUMMARY title="m">💭 内心独白 💭</SUMMARY>\n独白\n</DETAILS>';
  const source = safeExternal(`${choicesAttr}\n${monoAttr}\n${extra}`);
  const expected = `${safePrefix}${monoAttr}\n${choicesAttr}\n${extra}`;
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.deepEqual(result.warnings, []);
});

test('全大写 DETAILS/SUMMARY 标签仍按大小写不敏感识别并交换', () => {
  const upperChoices = choices.replaceAll('details', 'DETAILS').replaceAll('summary', 'SUMMARY');
  const upperMonologue = monologue.replaceAll('details', 'DETAILS').replaceAll('summary', 'SUMMARY');
  const source = safeExternal(`${upperChoices}\n${upperMonologue}`);
  const expected = `${safePrefix}${upperMonologue}\n${upperChoices}`;
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.deepEqual(result.warnings, []);
});

test('SDC-end 与 </content> 零空白紧邻仍视为安全边界并允许外部排序', () => {
  const compactPrefix = safePrefix.replace(`${sdcEnd}\n</content>`, `${sdcEnd}</content>`);
  const source = compactPrefix + choices + '\n' + monologue;
  const expected = compactPrefix + monologue + '\n' + choices;
  const result = transformContent(source, { repairSdcBoundary: true, repairDetailsOrder: true });
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.content.includes(`${sdcEnd}</content>`), 'zero-whitespace end/close adjacency preserved');
});

test('自定义标题关键词在运行期生效，且只匹配直接 summary 纯文本', () => {
  const source = safeExternal(`<details><summary>Chosen</summary>c</details>\n<details><summary>Inner voice</summary>m</details>`);
  const result = repairDetailsOutsideContent(source, { monologueKeyword: 'Inner voice', choicesKeyword: 'Chosen' });
  assert.equal(result.changed, true);
  assert.equal(result.content, `${safePrefix}<details><summary>Inner voice</summary>m</details>\n<details><summary>Chosen</summary>c</details>`);
  assert.deepEqual(result.warnings, []);
});

test('代码围栏、行内代码、code/pre 与 HTML 注释中的 details 示例不会参与排序', () => {
  const examples = [
    '```html',
    '<details><summary>内心独白</summary>示例</details>',
    '```',
    '`<details><summary>你的选择是</summary>行内</details>`',
    '<code><details><summary>内心独白</summary>code</details></code>',
    '<pre><details><summary>你的选择是</summary>pre</details></pre>',
    '<!-- <details><summary>内心独白</summary>注释</details> -->',
    '',
  ].join('\n');
  const source = safeExternal(`${examples}${choices}\n${monologue}`);
  const expected = `${safePrefix}${examples}${monologue}\n${choices}`;
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.deepEqual(result.warnings, []);
  for (const snippet of ['示例', '行内', 'code', 'pre', '注释']) {
    assert.equal(result.content.includes(snippet), true);
  }
});

test('交换后两个以上末尾未知 details 保持原字节与原相对顺序', () => {
  const unknown1 = '<details><summary>附加信息</summary>一</details>';
  const unknown2 = '<details class="future"><summary>未来块</summary>二</details>';
  const unknown3 = '<details><summary>页脚</summary>三</details>';
  const source = safeExternal(`${choices}\n${monologue}\n${unknown1}\n${unknown2}\n${unknown3}`);
  const expected = `${safePrefix}${monologue}\n${choices}\n${unknown1}\n${unknown2}\n${unknown3}`;
  const result = repairDetailsOutsideContent(source, {});
  assert.equal(result.changed, true);
  assert.equal(result.content, expected);
  assert.ok(result.content.indexOf(unknown1) < result.content.indexOf(unknown2));
  assert.ok(result.content.indexOf(unknown2) < result.content.indexOf(unknown3));
});

test('设置默认关闭、旧设置兼容；非法/空/相同关键词保留上次有效值，合法关键词首尾去空白并往返', () => {
  assert.equal(FEATURE_DEFAULTS.repairDetailsOrder, false);
  assert.equal(FEATURE_DEFAULTS.detailsMonologueKeyword, '内心独白');
  assert.equal(FEATURE_DEFAULTS.detailsChoicesKeyword, '你的选择是');
  const oldSettings = { removeLeakedReasoning: true, repairSdcBoundary: false };
  const readOld = readFeatureSettings(oldSettings);
  assert.equal(readOld.repairDetailsOrder, false);
  assert.equal(readOld.detailsMonologueKeyword, '内心独白');
  assert.equal(readOld.detailsChoicesKeyword, '你的选择是');

  const normalized = normalizeRepairSettings({ repairDetailsOrder: true });
  assert.equal(normalized.repairDetailsOrder, true);
  assert.equal(normalized.detailsMonologueKeyword, '内心独白');
  assert.equal(hasEnabledFeature({ repairDetailsOrder: true }), true);
  assert.equal(hasEnabledFeature({}), false);

  const previous = {
    removeLeakedReasoning: false,
    repairSdcBoundary: false,
    repairDetailsOrder: true,
    detailsMonologueKeyword: '默认独白',
    detailsChoicesKeyword: '默认选择',
    sdcCalendarSource: 'gouhua',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 10,
  };
  const invalidEmpty = mergeFeatureSettings(previous, {
    ...previous,
    detailsMonologueKeyword: '   ',
    detailsChoicesKeyword: '默认选择',
  });
  assert.equal(invalidEmpty.fields.detailsMonologueKeyword, '默认独白');
  assert.ok(invalidEmpty.warnings.some(item => /不能为空/.test(item)));

  const invalidEqual = mergeFeatureSettings(previous, {
    ...previous,
    detailsMonologueKeyword: '相同',
    detailsChoicesKeyword: '相同',
  });
  assert.equal(invalidEqual.fields.detailsMonologueKeyword, '默认独白');
  assert.equal(invalidEqual.fields.detailsChoicesKeyword, '默认选择');
  assert.ok(invalidEqual.warnings.some(item => /不能相同/.test(item)));

  const valid = mergeFeatureSettings(previous, {
    ...previous,
    detailsMonologueKeyword: '  独白  ',
    detailsChoicesKeyword: '  选择  ',
  });
  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.fields.detailsMonologueKeyword, '独白');
  assert.equal(valid.fields.detailsChoicesKeyword, '选择');
  assert.equal(valid.fields.repairDetailsOrder, true);
});

test('配置导出/导入包含新开关与关键词；旧导出兼容、非法字段原子拒绝、直接历法 JSON 保留上次值', () => {
  const previous = {
    removeLeakedReasoning: true,
    repairSdcBoundary: false,
    repairDetailsOrder: true,
    detailsMonologueKeyword: '自定义独白',
    detailsChoicesKeyword: '自定义选择',
    sdcCalendarSource: 'four-seasons-28',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 20,
  };
  const exported = createStructureSettingsExport(previous);
  assert.equal(exported.repairDetailsOrder, true);
  assert.equal(exported.detailsMonologueKeyword, '自定义独白');
  assert.equal(exported.detailsChoicesKeyword, '自定义选择');
  const roundTrip = importStructureSettingsText(JSON.stringify(exported), previous);
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.settings.repairDetailsOrder, true);
  assert.equal(roundTrip.settings.detailsMonologueKeyword, '自定义独白');
  assert.equal(roundTrip.settings.detailsChoicesKeyword, '自定义选择');

  const oldExport = importStructureSettingsText(JSON.stringify({
    format: 'response-linter-structure-settings',
    version: 1,
    removeLeakedReasoning: false,
    repairSdcBoundary: false,
    sdcCalendarSource: 'four-seasons-28',
    sdcCustomCalendarJson: '',
    sdcAdvanceMinutes: 20,
  }), previous);
  assert.equal(oldExport.ok, true);
  assert.equal(oldExport.settings.repairDetailsOrder, true, 'old exports preserve previous new-switch value');
  assert.equal(oldExport.settings.detailsMonologueKeyword, '自定义独白');
  assert.equal(oldExport.settings.detailsChoicesKeyword, '自定义选择');

  const before = structuredClone(previous);
  for (const bad of [
    { repairDetailsOrder: 'true' },
    { repairDetailsOrder: false, detailsMonologueKeyword: '' },
    { detailsMonologueKeyword: '相同', detailsChoicesKeyword: '相同' },
    { detailsMonologueKeyword: 3 },
  ]) {
    const result = importStructureSettingsText(JSON.stringify(bad), previous);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(previous, before);

  const directCalendar = importStructureSettingsText(JSON.stringify({
    months: [{ name: '春', days: 28 }, { name: '夏', days: 28 }],
    weekdayCycle: 7,
    dateFormat: '{year}年{month}{day}日',
  }), previous);
  assert.equal(directCalendar.ok, true);
  assert.equal(directCalendar.settings.sdcCalendarSource, 'custom');
  assert.equal(directCalendar.settings.repairDetailsOrder, true);
  assert.equal(directCalendar.settings.detailsMonologueKeyword, '自定义独白');
  assert.throws(() => createStructureSettingsExport({ ...previous, detailsChoicesKeyword: '自定义独白' }), /不能相同/);
});

test('新开关独自启用 hasEnabledFeature 与手动修复按钮，后端状态不再视为“无活跃规则”', () => {
  assert.equal(hasEnabledFeature({ enabled: true, rules: [], repairDetailsOrder: true }), true);
  const props = {};
  globalThis.$ = selector => ({
    prop(key, value) {
      if (arguments.length > 1) { props[`${selector}:${key}`] = value; return this; }
      return props[`${selector}:${key}`];
    },
    attr(key, value) {
      if (arguments.length > 1) { props[`${selector}:${key}`] = value; return this; }
      return props[`${selector}:${key}`];
    },
    text() { return this; },
    toggleClass() { return this; },
    addClass() { return this; },
    removeClass() { return this; },
  });
  const ui = new UIStateManager();
  window.extension_settings = {};
  window.backendController = {
    getLatestAIMessage: () => ({ id: '0', content: '<content>正文' }),
    canUndoFix: () => false,
    getStatus: () => ({ isRunning: true }),
  };
  __testContext.extensionSettings['response-linter'] = {
    enabled: true, rules: [], repairDetailsOrder: true,
  };
  ui.refreshManualFixButton();
  assert.equal(props['#rl-manual-fix:disabled'], false);
  ui.updateStatusIndicator();
  assert.equal(props['#rl-status-indicator:title'], '扩展运行中');
  delete globalThis.$;
  delete window.backendController;
  delete window.extension_settings;
});

test('无用户规则时手动修复、撤销、预览确认、撤销均使用同一转换', async () => {
  const source = safeExternal(`${choices}\n${monologue}`);
  const expected = `${safePrefix}${monologue}\n${choices}`;
  __testContext.chat = [messageFixture(source)];
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'apply', rules: [],
    repairDetailsOrder: true,
  });
  const applied = await controller.triggerManualFix('0');
  assert.equal(applied.success, true);
  assert.equal(__testContext.chat[0].mes, expected);
  assert.equal(__testContext.chat[0].extra.display_text, expected);
  assert.equal(__testContext.chat[0].swipes[0], expected);
  assert.equal(saves, 1);
  assert.equal(controller.canUndoFix('0'), true);
  assert.equal((await controller.undoFix('0')).success, true);
  assert.equal(__testContext.chat[0].mes, source);
  assert.equal(saves, 2);

  __testContext.chat = [messageFixture(source)];
  controller.updateSettings({
    enabled: true, autoFix: false, defaultAutoFixAction: 'preview', rules: [],
    repairDetailsOrder: true,
  });
  const pending = await controller.triggerManualFix('0');
  assert.equal(pending.metadata?.requiresConfirmation, true);
  assert.equal(saves, 2);
  assert.equal(__testContext.chat[0].mes, source);
  assert.equal((await controller.confirmFix('0', true)).success, true);
  assert.equal(__testContext.chat[0].mes, expected);
  assert.equal(saves, 3);
  assert.equal((await controller.undoFix('0')).success, true);
  assert.equal(__testContext.chat[0].mes, source);
  assert.equal(saves, 4);
});

test('自动修复路径使用同一转换且只写一次；流式生成期间跳过；预览确认拒绝已编辑消息', async () => {
  const source = safeExternal(`${choices}\n${monologue}`);
  const expected = `${safePrefix}${monologue}\n${choices}`;
  __testContext.chat = [messageFixture(source)];
  controller.updateSettings({ enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [], repairDetailsOrder: true });
  const applied = waitForEvent('responseLinter.fixApplied');
  await messageHandler._processMessage('0');
  await applied;
  assert.equal(__testContext.chat[0].mes, expected);
  assert.equal(__testContext.chat[0].extra.display_text, expected);
  assert.equal(saves, 1);

  await messageHandler._processMessage('0');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(saves, 1, 'same content is deduplicated');

  __testContext.chat = [messageFixture(source)];
  __testContext.streamingProcessor = { isFinished: false };
  controller.updateSettings({ enabled: true, autoFix: true, defaultAutoFixAction: 'apply', rules: [], repairDetailsOrder: true });
  await messageHandler._processMessage('0');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(saves, 1);
  assert.equal(__testContext.chat[0].mes, source);
  __testContext.streamingProcessor = null;

  __testContext.chat = [messageFixture(source)];
  controller.updateSettings({ enabled: true, autoFix: false, defaultAutoFixAction: 'preview', rules: [], repairDetailsOrder: true });
  await controller.triggerManualFix('0');
  __testContext.chat[0].mes = `${source} 已编辑`;
  __testContext.chat[0].extra.display_text = __testContext.chat[0].mes;
  const rejected = await controller.confirmFix('0', true);
  assert.equal(rejected.success, false);
  assert.equal(saves, 1);
  assert.ok(__testContext.chat[0].mes.endsWith('已编辑'));
});
