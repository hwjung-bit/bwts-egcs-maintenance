// DOM helpers shared by every tab. No data access here.

export function $(id) { return document.getElementById(id); }

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg) {
  const t = $('toast');
  if (!t) { console.log('[toast]', msg); return; }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2500);
}

export function pad(n) { return n < 10 ? '0' + n : '' + n; }

export function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d); if (isNaN(x)) return '—';
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* Floating text preview (mail subject hover) */
export function showPreview(e) {
  const el = e.currentTarget;
  const text = el.getAttribute('data-preview');
  if (!text) return;
  const box = $('previewFloat');
  box.textContent = text;
  box.style.display = 'block';
  const rect = el.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let left = rect.left, top = rect.bottom + 6;
  if (left + bw > window.innerWidth - 10) left = window.innerWidth - bw - 10;
  if (top + bh > window.innerHeight - 10) top = rect.top - bh - 6;
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}
export function hidePreview() {
  const box = $('previewFloat'); if (box) box.style.display = 'none';
}

/* Position a fixed popup near a click, kept inside the viewport */
export function placePopup(pop, ev, width) {
  pop.style.display = 'block';
  const top = Math.min(ev.clientY + 12, window.innerHeight - pop.offsetHeight - 12);
  const left = Math.min(ev.clientX + 12, window.innerWidth - (width || pop.offsetWidth) - 16);
  pop.style.top = Math.max(12, top) + 'px';
  pop.style.left = Math.max(12, left) + 'px';
}

/* Inline single-line editor: replaces el's text with an input, saves on
   blur/Enter, cancels on Escape. onSave(value) does the persistence. */
export function inlineEdit(el, cur, onSave, opts) {
  opts = opts || {};
  const inp = document.createElement('input');
  inp.type = opts.type || 'text';
  inp.value = cur || '';
  inp.placeholder = opts.placeholder || '';
  inp.style.cssText = opts.css ||
    'width:100%;font-size:12px;padding:3px 6px;border:1px solid #3b82f6;border-radius:4px;outline:none';
  const restore = opts.restore || (() => { el.textContent = cur || (opts.empty || ''); });
  if (opts.hide) { el.style.display = 'none'; el.parentNode.appendChild(inp); }
  else { el.textContent = ''; el.appendChild(inp); }
  inp.focus();
  function save() {
    inp.onblur = null;   // removing the node below must not re-enter save()
    const v = opts.type === 'date' ? inp.value : inp.value.trim();
    if (opts.hide) { el.style.display = ''; inp.remove(); }
    onSave(v);
  }
  inp.onblur = save;
  // Enter saves through blur so save() runs once; Escape drops the handler
  // first or cancelling would save.
  inp.onkeydown = e => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') {
      inp.onblur = null;
      if (opts.hide) { el.style.display = ''; inp.remove(); } else restore();
    }
  };
  return inp;
}

// Handlers referenced from HTML strings
window.ui = { showPreview, hidePreview };

// Close attachment popup on any click
document.addEventListener('click', () => {
  const pop = $('attPop'); if (pop) pop.style.display = 'none';
});
