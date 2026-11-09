// 通用 UI 工具（无框架，纯 DOM）
import { t } from './i18n.js';

/** h('div', {class:'x', onclick: fn}, child1, 'text', [child2]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const MYR = new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' });
export const money = (sen) => (sen === null || sen === undefined ? '—' : MYR.format(sen / 100));
export const num = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-MY', { maximumFractionDigits: d }));
export const senToInput = (sen) => (sen === null || sen === undefined ? '' : (sen / 100).toFixed(2));

/** 马来西亚时区日期 */
export function klDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
export function addDays(s, n) {
  return new Date(Date.parse(s + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
}
export function klDateTime(iso) {
  if (!iso) return '—';
  return new Date(Date.parse(iso) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);

export function sourceBadges(bySource) {
  const keys = Object.keys(bySource || {});
  if (!keys.length) return badge(t('src_none'), 'muted');
  return h('span', { class: 'badges' }, keys.map((k) => badge(t('src_' + k), 'src-' + k)));
}

export const stateBadge = (state) => badge(t('state_' + state) || state, `state-${state}`);

export function toast(msg, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

export async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), 'error');
    throw e;
  }
}

/** 表格：columns = [{ label, render(row) | key, class }] */
export function table(columns, rows, { empty } = {}) {
  if (!rows?.length) return h('div', { class: 'empty' }, empty || t('noData'));
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.class }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.class }, c.render ? c.render(r) : r[c.key] ?? '—')))))));
}

/**
 * 表单字段定义：{ name, label, type: text|number|password|select|date|datetime|textarea|checkbox, options: [[v,label]], value, required, hint, step }
 */
export function formField(f) {
  let input;
  if (f.type === 'select') {
    input = h('select', { name: f.name, required: f.required, multiple: f.multiple },
      f.options.map(([v, l]) => h('option', { value: v, selected: f.multiple ? (f.value || []).map(String).includes(String(v)) : String(v) === String(f.value ?? '') }, l)));
  } else if (f.type === 'textarea') {
    input = h('textarea', { name: f.name, rows: f.rows || 4, required: f.required, placeholder: f.placeholder }, f.value ?? '');
  } else if (f.type === 'checkbox') {
    input = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
    return h('label', { class: 'field checkbox' }, input, h('span', {}, f.label));
  } else {
    input = h('input', {
      name: f.name, type: f.type === 'datetime' ? 'text' : f.type || 'text', value: f.value ?? '', required: f.required,
      step: f.step || (f.type === 'number' ? 'any' : undefined), placeholder: f.placeholder, autocomplete: f.autocomplete || 'off',
    });
  }
  return h('label', { class: 'field' }, h('span', {}, f.label, f.required ? ' *' : ''), input, f.hint ? h('small', {}, f.hint) : null);
}

export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

/** 模态表单。onSubmit 返回 Promise；成功后关闭 */
export function modal(title, fields, onSubmit, { submitLabel, extra } = {}) {
  const form = h('form', { class: 'modal-form' }, fields.map((f) => (f instanceof Node ? f : formField(f))), extra);
  const close = () => overlay.remove();
  const btn = h('button', { type: 'submit', class: 'primary' }, submitLabel || t('save'));
  form.append(h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: close }, t('cancel')), btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await onSubmit(readForm(form), form);
      close();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' }, h('h3', {}, title), form));
  document.body.append(overlay);
  form.querySelector('input,select,textarea')?.focus();
  return { close, form };
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' },
      h('div', { class: 'modal small' }, h('p', {}, message),
        h('div', { class: 'modal-actions' },
          h('button', { onclick: () => { overlay.remove(); resolve(false); } }, t('cancel')),
          h('button', { class: 'danger', onclick: () => { overlay.remove(); resolve(true); } }, t('confirm')))));
    document.body.append(overlay);
  });
}

/** 简单 SVG 柱状趋势图 */
export function barChart(points, { valueKey = 'sales', labelKey = 'day', format = money } = {}) {
  if (!points.length) return h('div', { class: 'empty' }, t('noData'));
  const W = 800, H = 200, pad = 28;
  const max = Math.max(...points.map((p) => p[valueKey]), 1);
  const bw = Math.min(60, (W - pad * 2) / points.length);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  points.forEach((p, i) => {
    const bh = ((H - pad * 2) * p[valueKey]) / max;
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', pad + i * bw + bw * 0.15);
    r.setAttribute('y', H - pad - bh);
    r.setAttribute('width', bw * 0.7);
    r.setAttribute('height', Math.max(bh, 1));
    r.setAttribute('rx', 2);
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${p[labelKey]}: ${format(p[valueKey])}`;
    r.append(title);
    svg.append(r);
    if (points.length <= 31 && (i % Math.ceil(points.length / 10) === 0 || i === points.length - 1)) {
      const tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', pad + i * bw + bw / 2);
      tx.setAttribute('y', H - 8);
      tx.setAttribute('text-anchor', 'middle');
      tx.textContent = String(p[labelKey]).slice(5);
      svg.append(tx);
    }
  });
  return svg;
}

/** 读取本地文件文本 */
export function pickFile(accept = '.csv') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name, text: reader.result });
      reader.readAsText(f, 'utf-8');
    });
    input.click();
  });
}

/** replaceChildren 的安全版本：忽略 null/false */
export function setContent(el, ...children) {
  el.replaceChildren();
  append(el, children);
}
