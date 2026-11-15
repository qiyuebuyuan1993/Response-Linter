// A preview belongs to this extension, so navigation can close it without
// dismissing an unrelated host/plugin popup.
export function openRepairPreview(html, isCurrent) {
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'rl-modal rl-repair-preview';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '确认修复');
  overlay.innerHTML = `<div class="rl-modal-content">
    <div class="rl-modal-header"><h3>确认修复</h3><button type="button" class="menu_button" data-action="cancel" aria-label="关闭修复预览">×</button></div>
    <div class="rl-modal-body">${html}</div>
    <div class="rl-modal-footer"><button type="button" class="menu_button" data-action="apply">应用修复</button><button type="button" class="menu_button secondary" data-action="cancel">取消</button></div>
  </div>`;
  let resolve;
  let finished = false;
  const result = new Promise(done => { resolve = done; });
  const close = (confirmed = false, invalidated = false) => {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus?.();
    resolve({ confirmed, invalidated });
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key !== 'Tab') return;
    const buttons = [...overlay.querySelectorAll('button:not([disabled])')];
    const target = event.shiftKey ? buttons.at(-1) : buttons[0];
    if ((!event.shiftKey && document.activeElement === buttons.at(-1)) ||
        (event.shiftKey && document.activeElement === buttons[0])) {
      event.preventDefault(); target?.focus();
    }
  };
  overlay.addEventListener('click', event => {
    const action = event.target.closest?.('[data-action]')?.dataset.action;
    if (event.target === overlay || action === 'cancel') close();
    else if (action === 'apply') { if (isCurrent()) close(true); else close(false, true); }
  });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('[data-action="apply"]').focus();
  return { result, close };
}
