import { diagnosticSnapshot } from '../../core/diagnostic-status.js';
import { clearDiagnostics } from '../../core/diagnostics.js';

export function setupDiagnosticsUI(getSettings) {
  const root = document.getElementById('rl-diagnostics');
  if (!root || root.dataset.bound) return;
  root.dataset.bound = 'true';
  const output = root.querySelector('#rl-diagnostics-output');
  const status = root.querySelector('#rl-diagnostics-status');
  const refresh = () => {
    const json = JSON.stringify(diagnosticSnapshot(getSettings()), null, 2);
    output.textContent = json;
    return json;
  };
  root.addEventListener('toggle', () => { if (root.open) refresh(); });
  root.querySelector('#rl-diagnostics-refresh').addEventListener('click', refresh);
  root.querySelector('#rl-diagnostics-clear').addEventListener('click', () => { clearDiagnostics(); refresh(); status.textContent = '本次诊断记录已清空。'; });
  root.querySelector('#rl-diagnostics-copy').addEventListener('click', async () => {
    const json = refresh();
    try { await navigator.clipboard.writeText(json); status.textContent = '已复制诊断，可直接发来排查。'; }
    catch { status.textContent = '当前环境不支持复制，请使用“下载诊断”。'; }
  });
  root.querySelector('#rl-diagnostics-download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([refresh()], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'response-linter-diagnostics.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = '已生成诊断文件。';
  });
}
