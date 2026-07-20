'use strict';

// ---------- state ----------
let state = { machines: [], names: [] };
let pollTimer = null;
let searchQuery = '';
let mode = 'all'; // 'all' | 'card'
let activeMachineId = null; // machine with an open inline form (edit or queue); skip re-render during poll

// persistent identity
let lastUser = localStorage.getItem('lastUser') || '';
let lastInfo = localStorage.getItem('lastInfo') || '';
let activeTags = new Set(JSON.parse(localStorage.getItem('activeTags') || '[]'));

const PRESET_TAGS = ['长期占用', '短期', '训练中', '推理中', '调试', '跑批', '评估中', '占位待用'];

// ---------- api ----------
const api = (path, opts = {}) =>
  fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then((r) => r.json().then((data) => ({ ok: r.ok, status: r.status, data })));

async function refresh() {
  const { ok, data } = await api('/api/state');
  const ind = document.getElementById('sync-indicator');
  if (ok) { ind.classList.remove('bad'); state = data; render(); }
  else ind.classList.add('bad');
}

// ---------- helpers ----------
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  return `${Math.floor(hr / 24)}天`;
}
function currentUser() { return document.getElementById('who-name').value.trim(); }
function currentInfo() {
  const tags = [...activeTags].join(' / ');
  const extra = document.getElementById('who-info').value.trim();
  return [tags, extra].filter(Boolean).join(' · ');
}

// ---------- render ----------
function render() {
  const root = document.getElementById('machines');
  const empty = document.getElementById('empty-state');
  const noMatch = document.getElementById('no-match');
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? state.machines.filter((m) =>
        m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
    : state.machines;

  if (!state.machines.length) {
    root.innerHTML = '';
    empty.hidden = false; noMatch.hidden = true; return;
  }
  empty.hidden = true;
  noMatch.hidden = filtered.length > 0;

  // If a machine has an open inline form (edit or queue), preserve its DOM node
  // so the user's in-progress typing isn't wiped by a poll refresh.
  let preservedNode = null;
  if (activeMachineId) {
    preservedNode = root.querySelector(`.machine[data-mid="${activeMachineId}"]`);
  }
  root.innerHTML = '';
  if (!filtered.length) return;

  for (const m of filtered) {
    if (preservedNode && m.id === activeMachineId) {
      root.appendChild(preservedNode); // keep user's in-progress input
    } else {
      root.appendChild(renderMachine(m));
    }
  }

  // name datalist
  const dl = document.getElementById('name-list');
  dl.innerHTML = state.names.map((n) => `<option value="${escapeHtml(n)}">`).join('');
}

function renderMachine(m) {
  const free = m.cards.filter((c) => !c.occupancy).length;
  const total = m.cards.length;
  const mine = m.cards.filter((c) => c.occupancy && c.occupancy.user === lastUser).length;

  const card = el('div', 'machine');
  card.dataset.mid = m.id;
  card.innerHTML = `
    <div class="machine-head">
      <div class="machine-title">
        <h2>${escapeHtml(m.name)}</h2>
        <span class="machine-stats"><b>${free}</b>/<b>${total}</b> 空闲${mine ? ` · <b>${mine}</b> 我的` : ''}</span>
      </div>
      <div class="machine-actions">
        ${free > 0 ? `<button class="btn btn-sm btn-primary" data-act="occupy-all" data-mid="${m.id}">占用</button>` : ''}
        ${mine > 0 ? `<button class="btn btn-sm" data-act="release-mine" data-mid="${m.id}">释放我的</button>` : ''}
        <button class="btn btn-sm" data-act="queue" data-mid="${m.id}">排队</button>
        <button class="btn btn-sm btn-ghost" data-act="edit" data-mid="${m.id}" title="编辑机器信息">✎</button>
        <button class="btn btn-sm btn-ghost" data-act="addcards" data-mid="${m.id}" title="增加卡">+卡</button>
        <button class="btn btn-sm btn-danger" data-act="del" data-mid="${m.id}" title="删除机器">删</button>
      </div>
    </div>`;
  if (m.description) card.appendChild(el('div', 'machine-desc', escapeHtml(m.description)));

  const grid = el('div', 'card-grid');
  for (const c of m.cards) grid.appendChild(renderGpu(c));
  card.appendChild(grid);

  const q = el('div', 'queue');
  q.innerHTML = `<div class="queue-head">排队 (${m.queue.length})</div>`;
  const list = el('div', 'queue-list');
  m.queue.forEach((item, i) => {
    const row = el('div', 'queue-item');
    row.innerHTML = `
      <span><span class="q-pos">${i + 1}</span> <span class="q-name">${escapeHtml(item.user)}</span>
        ${item.info ? `<span class="q-info">· ${escapeHtml(item.info)}</span>` : ''}
        <span class="q-info">· ${relTime(item.since)}</span>
      </span>
      <button class="btn btn-sm btn-ghost" data-act="leaveq" data-mid="${m.id}" data-qid="${item.id}" data-user="${escapeHtml(item.user)}">退出</button>`;
    list.appendChild(row);
  });
  q.appendChild(list);
  card.appendChild(q);

  return card;
}

function renderGpu(c) {
  const mine = c.occupancy && c.occupancy.user === lastUser;
  const node = el('div', c.occupancy ? (mine ? 'gpu busy mine' : 'gpu busy') : 'gpu free');
  // concise: label + user only; details on hover via title
  if (c.occupancy) {
    node.innerHTML = `
      <div class="gpu-label">${escapeHtml(c.label)}</div>
      <div class="gpu-user">${escapeHtml(c.occupancy.user)}</div>`;
    const detail = [c.occupancy.info, relTime(c.occupancy.since)].filter(Boolean).join(' · ');
    node.title = mine ? `${c.occupancy.user}(我) · ${detail} · 点击释放` : `${c.occupancy.user} · ${detail}`;
  } else {
    node.innerHTML = `
      <div class="gpu-label">${escapeHtml(c.label)}</div>
      <div class="gpu-status">空闲</div>`;
    node.title = mode === 'card' ? '点击占用此卡' : '切到「按卡占用」模式后可单选';
  }
  return node;
}

// ---------- actions ----------
async function occupyCards(mid, cardIds, user, info) {
  const { ok, data } = await api(`/api/machines/${mid}/occupy`, { method: 'POST', body: { cardIds, user, info } });
  if (!ok) { toast(data.error || '占用失败', 'error'); return false; }
  lastUser = user; localStorage.setItem('lastUser', user);
  await refresh();
  return true;
}

async function releaseCards(mid, cardIds, user) {
  const { ok, data } = await api(`/api/machines/${mid}/release`, { method: 'POST', body: { cardIds, user } });
  if (!ok) { toast(data.error || '释放失败', 'error'); return; }
  await refresh();
  toast(data.released ? `已释放 ${data.released} 张` : '无可释放', data.released ? 'ok' : 'error');
}

// ---------- event delegation (machine area) ----------
document.getElementById('machines').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    const mid = btn.dataset.mid;
    if (act === 'occupy-all') {
      const m = state.machines.find((x) => x.id === mid);
      const user = currentUser();
      if (!user) return toast('请先在顶部填名字', 'error');
      const ids = m.cards.filter((c) => !c.occupancy).map((c) => c.id);
      if (!ids.length) return toast('没有空闲卡', 'error');
      if (await occupyCards(mid, ids, user, currentInfo())) toast(`已占用 ${ids.length} 张卡`, 'ok');
      return;
    }
    if (act === 'release-mine') {
      const m = state.machines.find((x) => x.id === mid);
      const ids = m.cards.filter((c) => c.occupancy && c.occupancy.user === lastUser).map((c) => c.id);
      if (!ids.length) return;
      return releaseCards(mid, ids, lastUser);
    }
    if (act === 'queue') return openQueueJoin(mid);
    if (act === 'edit') return openMachineEdit(mid);
    if (act === 'addcards') {
      const n = prompt('要增加几张卡?', '1');
      if (!n) return;
      const { ok, data } = await api(`/api/machines/${mid}/cards`, { method: 'POST', body: { count: parseInt(n, 10) || 1 } });
      if (!ok) return toast(data.error || '失败', 'error');
      await refresh(); return toast('已增加卡', 'ok');
    }
    if (act === 'del') {
      if (!confirm('删除这台机器及其所有占用/排队记录?')) return;
      const { ok, data } = await api(`/api/machines/${mid}`, { method: 'DELETE' });
      if (!ok) return toast(data.error || '失败', 'error');
      await refresh(); return toast('已删除', 'ok');
    }
    if (act === 'leaveq') {
      const { ok, data } = await api(`/api/machines/${mid}/queue/${btn.dataset.qid}/leave`, { method: 'POST', body: { user: btn.dataset.user } });
      if (!ok) return toast(data.error || '失败', 'error');
      await refresh();
    }
    return;
  }

  // click on an NPU card
  const gpu = e.target.closest('.gpu');
  if (!gpu) return;
  const machineEl = gpu.closest('.machine');
  const mid = machineEl.dataset.mid;
  const m = state.machines.find((x) => x.id === mid);
  if (!m) return;
  const label = gpu.querySelector('.gpu-label').textContent;
  const cardObj = m.cards.find((c) => c.label === label);
  if (!cardObj) return;

  if (!cardObj.occupancy) {
    if (mode !== 'card') {
      toast('当前是「全部占用」模式。切到「按卡占用」可单选,或点机器「占用」按钮占满', '');
      return;
    }
    const user = currentUser();
    if (!user) return toast('请先在顶部填名字', 'error');
    if (await occupyCards(mid, [cardObj.id], user, currentInfo())) toast(`已占用 ${cardObj.label}`, 'ok');
  } else if (cardObj.occupancy.user === lastUser) {
    await releaseCards(mid, [cardObj.id], lastUser);
  } else {
    toast(`${cardObj.label} 被 ${cardObj.occupancy.user} 占用`, '');
  }
});

// ---------- machine edit (inline) ----------
function openMachineEdit(mid) {
  const m = state.machines.find((x) => x.id === mid);
  if (!m) return;
  const machineEl = [...document.querySelectorAll('.machine')].find((e2) => e2.dataset.mid === mid);
  if (!machineEl) return;
  // remove any existing edit row
  machineEl.querySelectorAll('.machine-edit').forEach((n) => n.remove());
  const head = machineEl.querySelector('.machine-head');
  const row = el('div', 'machine-edit');
  row.innerHTML = `
    <input class="me-name" type="text" value="${escapeHtml(m.name)}" placeholder="机器名称" />
    <input class="me-desc" type="text" value="${escapeHtml(m.description || '')}" placeholder="描述(可选)" />
    <button class="btn btn-sm btn-primary me-save">保存</button>
    <button class="btn btn-sm btn-ghost me-cancel">取消</button>`;
  head.after(row);
  const nameInp = row.querySelector('.me-name');
  const descInp = row.querySelector('.me-desc');
  activeMachineId = mid; // pause re-render of this machine while typing
  setTimeout(() => { nameInp.focus(); nameInp.select(); }, 30);
  const closeEdit = () => { activeMachineId = null; row.remove(); };
  row.querySelector('.me-save').onclick = async () => {
    const name = nameInp.value.trim();
    if (!name) return toast('请输入名称', 'error');
    const { ok, data } = await api(`/api/machines/${mid}`, { method: 'PATCH', body: { name, description: descInp.value.trim() } });
    if (!ok) return toast(data.error || '失败', 'error');
    activeMachineId = null;
    await refresh(); toast('已更新', 'ok');
  };
  row.querySelector('.me-cancel').onclick = closeEdit;
  [nameInp, descInp].forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.me-save').click(); }
    if (e.key === 'Escape') closeEdit();
  }));
}

// ---------- queue join (inline) ----------
function openQueueJoin(mid) {
  const machineEl = [...document.querySelectorAll('.machine')].find((e2) => e2.dataset.mid === mid);
  if (!machineEl) return;
  const q = machineEl.querySelector('.queue');
  q.querySelectorAll('.queue-join').forEach((n) => n.remove());
  const bar = el('div', 'queue-join');
  bar.innerHTML = `
    <input class="qj-user" type="text" list="name-list" value="${escapeHtml(lastUser)}" placeholder="名字 *" />
    <input class="qj-info" type="text" value="${escapeHtml(currentInfo())}" placeholder="备注(可选)" />
    <button class="btn btn-sm btn-primary qj-ok">加入</button>
    <button class="btn btn-sm btn-ghost qj-cancel">取消</button>`;
  q.appendChild(bar);
  const u = bar.querySelector('.qj-user');
  const i = bar.querySelector('.qj-info');
  activeMachineId = mid; // pause re-render of this machine while typing
  setTimeout(() => u.focus(), 30);
  const closeJoin = () => { activeMachineId = null; bar.remove(); };
  const submit = async () => {
    const user = u.value.trim();
    if (!user) { toast('请输入名字', 'error'); u.focus(); return; }
    const { ok, data } = await api(`/api/machines/${mid}/queue`, { method: 'POST', body: { user, info: i.value.trim() } });
    if (!ok) { toast(data.error || '排队失败', 'error'); return; }
    lastUser = user; localStorage.setItem('lastUser', user);
    activeMachineId = null;
    await refresh(); toast('已加入排队', 'ok');
  };
  bar.querySelector('.qj-ok').onclick = submit;
  bar.querySelector('.qj-cancel').onclick = closeJoin;
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') closeJoin(); });
  u.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.focus(); } if (e.key === 'Escape') closeJoin(); });
}

// ---------- who bar / mode / search ----------
function initWhoBar() {
  const nameInp = document.getElementById('who-name');
  const infoInp = document.getElementById('who-info');
  nameInp.value = lastUser;
  infoInp.value = lastInfo;
  nameInp.addEventListener('input', () => { lastUser = nameInp.value.trim(); localStorage.setItem('lastUser', lastUser); if (lastUser) render(); });
  infoInp.addEventListener('input', () => { lastInfo = infoInp.value; localStorage.setItem('lastInfo', lastInfo); });

  const tagsEl = document.getElementById('who-tags');
  PRESET_TAGS.forEach((t) => {
    const chip = el('div', 'who-tag' + (activeTags.has(t) ? ' active' : ''), escapeHtml(t));
    chip.onclick = () => {
      if (activeTags.has(t)) { activeTags.delete(t); chip.classList.remove('active'); }
      else { activeTags.add(t); chip.classList.add('active'); }
      localStorage.setItem('activeTags', JSON.stringify([...activeTags]));
    };
    tagsEl.appendChild(chip);
  });

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      render();
      toast(mode === 'all' ? '模式:全部占用(点机器「占用」占满)' : '模式:按卡占用(点单卡占用)', '');
    };
  });

  const search = document.getElementById('search');
  search.addEventListener('input', () => { searchQuery = search.value; render(); });
}

// ---------- add machine bar ----------
document.getElementById('btn-add-machine').onclick = () => {
  document.getElementById('add-machine-bar').hidden = false;
  setTimeout(() => document.getElementById('m-name').focus(), 30);
};
document.getElementById('m-cancel').onclick = () => { document.getElementById('add-machine-bar').hidden = true; };
document.getElementById('m-save').onclick = async () => {
  const name = document.getElementById('m-name').value.trim();
  if (!name) return toast('请输入机器名称', 'error');
  const body = {
    name,
    description: document.getElementById('m-desc').value.trim(),
    cardCount: parseInt(document.getElementById('m-count').value, 10) || 0,
  };
  const { ok, data } = await api('/api/machines', { method: 'POST', body });
  if (!ok) return toast(data.error || '失败', 'error');
  document.getElementById('add-machine-bar').hidden = true;
  document.getElementById('m-name').value = '';
  document.getElementById('m-desc').value = '';
  await refresh(); toast('已添加', 'ok');
};

// ---------- toast ----------
let toastTimer = null;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- polling ----------
function startPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(refresh, 4000); }
setInterval(() => render(), 60000);

// ---------- init ----------
(async function init() {
  initWhoBar();
  await refresh();
  startPolling();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
