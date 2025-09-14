// Lightweight UI helpers: toast notifications and injected styles
(function(){
  const style = document.createElement('style');
  style.textContent = `
    #toastHost { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 99999; }
    .toast { min-width: 220px; max-width: 360px; color: #fff; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: #0f1630cc; backdrop-filter: blur(6px); box-shadow: 0 6px 16px rgba(0,0,0,0.35); font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .toast.success { border-color: #10b98155; background: #064e3bcc; }
    .toast.error { border-color: #ef444455; background: #7f1d1dcc; }
    .toast.info { border-color: #3b82f655; background: #0b254dcc; }
  `;
  document.head.appendChild(style);

  const host = document.createElement('div');
  host.id = 'toastHost';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);

  window.toast = function(message, type='info', timeoutMs=2800){
    try {
      const t = document.createElement('div');
      t.className = `toast ${type}`;
      t.textContent = message;
      host.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(4px)'; }, Math.max(0, timeoutMs - 300));
      setTimeout(() => { t.remove(); }, timeoutMs);
    } catch (e) { /* fallback */ alert(message); }
  };
})();
