// 纯文本 HTML 转义工具。警告/失败原因来自消息或配置时，必须在进入 toastr 等
// HTML 渲染入口前转义；这里只做字符替换，不解析或重建模型内容。
const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

export function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPE_MAP[character]);
}

/**
 * 把多条警告拼成 toastr 可用的安全 HTML 片段，仅保留受控的 <br> 分隔。
 * @param {Array<unknown>} warnings
 * @returns {string}
 */
export function joinWarningToasts(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  return list.map(item => escapeHtmlText(item)).join('<br>');
}
