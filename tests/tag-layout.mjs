import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformContent } from '../core/repair-service.js';
import { createStructureSettingsExport, importStructureSettingsText } from '../core/settings-transfer.js';
import { validateStructureProfile } from '../core/structure-profiles.js';
import { formatTagLayoutForEditor } from '../core/tag-layout.js';

const timeStart = '<!-- SDC-start | date=1年夏6日 | weekday=周六 | time=20:10 -->';
const timeEnd = '<!-- SDC-end | date=1年夏6日 | weekday=周六 | time=20:35 -->';
const group = (name, title, text) =>
  '<' + name + '>\n<details>\n<summary style="list-style:none;">' + title +
  '</summary>\n' + text + '\n</details>\n</' + name + '>';
const sampleInside = group('status_qyl', '绮欲录', '示例内');
const sampleOutside = group('status_xssq', '行事拾趣', '示例外');
const inside = group('status_qyl', '换个标题', '正文附录的文字。');
const outside = group('status_xssq', '随回复变化', '状态内容。');
const detailA = '<details><summary>临时标题 A</summary>第二组内容</details>';
const detailB = '<details><summary>临时标题 B</summary>第三组内容</details>';
const narrative = ['<content>', timeStart, '正文中的普通叙述。'].join('\n');
const correct = [narrative, inside, timeEnd, '</content>', outside, detailA, detailB].join('\n');
const example = [narrative, sampleInside, timeEnd, '</content>', sampleOutside, detailA, detailB].join('\n');
const descriptor = { id: 'sample', name: '示例档案', layout: example, auxiliaries: ['<details>', '<版权水印>'] };
const profile = validateStructureProfile(descriptor).profile;
const settings = {
  structureProfiles: [profile],
  structureProfileId: profile.id,
  repairSdcBoundary: true,
  repairDetailsOrder: true,
  sdcCalendarSource: 'four-seasons-28',
};
const repair = (text, overrides = {}) => transformContent(text, { ...settings, ...overrides });

test('example sets body and SDC mode, exports only the tag structure, including stable id if present', () => {
  assert.deepEqual(profile.body, { open: '<content>', close: '</content>' });
  assert.equal(profile.time.mode, 'sdc');
  assert.match(profile.layout, /<status_qyl>\n\s+<details>\n\s+<summary><\/summary>/);
  const exported = createStructureSettingsExport(settings);
  const json = JSON.stringify(exported);
  assert.doesNotMatch(json, /绮欲录|临时标题|普通叙述|20:10|20:35|list-style/);
  const imported = importStructureSettingsText(json, {});
  assert.equal(imported.ok, true, imported.error);
  assert.deepEqual(imported.settings.structureProfiles, [profile]);
});

test('correct nesting and variable headings stay byte-for-byte intact, even with legacy details as an auxiliary', () => {
  for (const text of [correct, correct.replace(/\n/g, '\r\n')]) {
    const result = repair(text);
    assert.equal(result.content, text);
    assert.equal(result.changed, false);
    assert.deepEqual(result.warnings, []);
  }
});

test('a saved layout displays the SDC positions without saving the guides or overriding a time mode change', () => {
  const display = formatTagLayoutForEditor(profile.layout, profile.time.mode);
  assert.match(display, /^<content>\n  <!-- 开始时间 SDC-start -->\n  正文……/);
  assert.match(display, /<status_qyl>\n    <details>\n      <summary>标题（可变）<\/summary>/);
  assert.match(display, /<\/status_qyl>\n  <!-- 结束时间 SDC-end -->\n<\/content>\n<!-- 正文外的组 -->\n<status_xssq>/);
  assert.deepEqual(validateStructureProfile({ ...profile, layout: display }).profile, profile);
  const disabled = validateStructureProfile({ ...profile, layout: display, time: { mode: 'none' } }).profile;
  assert.equal(disabled.time.mode, 'none');
  assert.doesNotMatch(formatTagLayoutForEditor(disabled.layout, disabled.time.mode), /SDC-(?:start|end)/);
  assert.equal(formatTagLayoutForEditor(example, profile.time.mode), example);
});

test('misplaced outer and inner groups move as complete slices with SDC-end before the body close', () => {
  const wrong = [narrative, outside, '这行原文要保留。', detailA, timeEnd, '</content>', inside, detailB].join('\n');
  const result = repair(wrong);
  const text = result.content;
  assert.ok(result.changed);
  const sequence = [inside, timeEnd, '</content>', outside, detailA, detailB];
  assert.deepEqual(sequence.map(item => text.indexOf(item)).slice().sort((a, b) => a - b), sequence.map(item => text.indexOf(item)));
  assert.ok(sequence.every(item => text.includes(item)));
  assert.ok(text.includes('这行原文要保留。'));
  assert.equal(repair(text).content, text);
});

test('absent entire pairs are skipped at every level', () => {
  const partialOutside = '<status_xssq>没有折叠块的原文。</status_xssq>';
  const text = [narrative, timeEnd, '</content>', partialOutside].join('\n');
  const result = repair(text);
  assert.equal(result.content, text);
  assert.deepEqual(result.warnings, []);
  const noBody = outside + '\n' + detailA;
  const noBodyResult = repair(noBody);
  assert.equal(noBodyResult.content, noBody);
  assert.deepEqual(noBodyResult.warnings, []);
});

for (const [name, target, token, inserted] of [
  ['inside wrapper opener', inside, '<status_qyl>\n', '<status_qyl>'],
  ['inside wrapper closer', inside, '\n</status_qyl>', '</status_qyl>'],
  ['inside details opener', inside, '<details>\n', '<details>'],
  ['inside details closer', inside, '\n</details>', '</details>'],
  ['inside summary opener', inside, '<summary style="list-style:none;">', '<summary>'],
  ['inside summary closer', inside, '</summary>', '</summary>'],
  ['outside wrapper opener', outside, '<status_xssq>\n', '<status_xssq>'],
  ['outside wrapper closer', outside, '\n</status_xssq>', '</status_xssq>'],
  ['standalone details opener', detailA, '<details>', '<details>'],
  ['standalone details closer', detailA, '</details>', '</details>'],
  ['last details closer at EOF', detailB, '</details>', '</details>'],
  ['body opener', narrative, '<content>\n', '<content>'],
  ['body closer', '</content>', '</content>\n', '</content>'],
]) {
  test('repairs a missing ' + name + ' without creating absent pairs', () => {
    const omitted = target === '</content>'
      ? correct.replace(token, '')
      : correct.replace(target, target.replace(token, ''));
    const result = repair(omitted);
    assert.equal(result.changed, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.content.split(inserted).length, correct.split(inserted).length +
      (inserted === '<summary>' && target.includes('style=') ? 1 : 0));
    assert.ok(result.content.indexOf(timeEnd) < result.content.indexOf('</content>'));
    assert.ok(result.content.indexOf('</status_qyl>') < result.content.indexOf(timeEnd));
    assert.ok(result.content.indexOf('</content>') < result.content.indexOf('<status_xssq>'));
    for (const phrase of ['正文附录的文字。', '状态内容。', '第二组内容', '第三组内容']) {
      assert.equal(result.content.split(phrase).length, 2);
    }
    assert.equal(repair(result.content).content, result.content);
  });
}

test('repair inserts a synthesized end after the last inside group, using the configured calendar', () => {
  const late = '<!-- SDC-start | date=1年冬28日 | weekday=周日 | time=23:50 -->';
  const result = repair(correct.replace(timeEnd + '\n', '').replace(timeStart, late));
  assert.equal(result.content, correct.replace(timeStart, late).replace(timeEnd,
    '<!-- SDC-end | date=2年春1日 | weekday=周一 | time=00:00 -->'));
});

test('custom tag and id order are taken from the chosen example, with nested children moved in their own parent', () => {
  const custom = validateStructureProfile({
    id: 'alt', name: '任意正文',
    layout: '<story><status><first></first><second></second></status></story>' +
      '<details id="options"><summary></summary></details><details id="monologue"><summary></summary></details>',
  }).profile;
  const options = '<DETAILS title="a > b" id="options"><summary>实际选项</summary></DETAILS>';
  const monologue = '<details id="monologue"><summary>变化的标题</summary>另一段</details>';
  const unknown = '<addendum><details id="monologue">未知嵌套保持原样</details></addendum>';
  const text = '<story>正文<status><second>B</second>原样<first>A</first></status></story>\n' +
    [monologue, unknown, options].join('\n');
  const result = repair(text, { structureProfiles: [custom], structureProfileId: custom.id });
  assert.equal(result.content, '<story>正文<status><first>A</first>原样<second>B</second></status></story>\n' +
    [options, unknown, monologue].join('\n'));
});

test('structural anchors ignore protected code and comments and leave an unknown exterior tail intact', () => {
  const code = '\x60\x60\x60html\n<status_xssq>演示</status_xssq>\n</content>\n\x60\x60\x60\n';
  const source = correct.replace(inside, code + '<!-- <status_xssq>示例</status_xssq> -->\n' + inside)
    .replace('</content>\n', '</content>\n<尾注>末尾保留</尾注>\n');
  assert.equal(repair(source).content, source);
});

test('a comment example inside a closed code fence cannot hide the following real tags', () => {
  const code = '~~~html\n<!-- 未闭合的演示注释\n~~~\n';
  const source = correct.replace(inside, code + inside).replace('</status_qyl>', '');
  const result = repair(source);
  assert.ok(result.changed);
  assert.ok(result.content.includes(code));
  const closing = result.content.indexOf('</status_qyl>');
  assert.ok(closing >= 0);
  assert.equal(result.content.slice(closing + '</status_qyl>'.length, result.content.indexOf(timeEnd)).trim(), '');
});

test('an unclosed code fence prevents insertion of an invisible closing pair at EOF', () => {
  const text = narrative + '\n~~~html\n<content>此处是代码';
  const result = repair(text);
  assert.equal(result.content, text);
  assert.match(result.warnings.join(' '), /代码或未闭合/);
});

test('duplicate body or time markers prevent moving groups whose body ownership is unclear', () => {
  const text = correct + '\n' + timeEnd;
  const result = repair(text);
  assert.equal(result.content, text);
  assert.match(result.warnings.join(' '), /出现多次/);
});

test('a structure-only pass stays within the current body boundary', () => {
  const text = [narrative, outside, timeEnd, '</content>', inside, detailA, detailB].join('\n');
  const structureOnly = repair(text, { repairSdcBoundary: false });
  assert.equal(structureOnly.content, text);
  assert.match(structureOnly.warnings.join(' '), /跨过正文边界/);
  const boundaryOnly = repair(text, { repairDetailsOrder: false });
  assert.equal(boundaryOnly.content, text);
  assert.match(boundaryOnly.warnings.join(' '), /无法安全确定正文边界/);
});

test('ambiguous repeated roles and incomplete configuration samples cannot overwrite a valid profile', () => {
  for (const layout of [
    '<content><status></content>',
    '<content><details></details></content><details></details>',
    '<content></content><details></details><wrap></wrap><details></details>',
  ]) {
    assert.equal(validateStructureProfile({ ...descriptor, layout }).ok, false);
    const imported = importStructureSettingsText(JSON.stringify({
      structureProfiles: [{ ...descriptor, layout }],
      structureProfileId: descriptor.id,
    }), settings);
    assert.equal(imported.ok, false);
  }
});
