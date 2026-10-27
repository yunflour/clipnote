'use strict';
/* ClipNote 前端：剪切板 + 笔记本，3 秒轮询多端同步 */
const $ = (id) => document.getElementById(id);

const state = {
  tab: 'clip',
  clips: [],
  notes: [],
  noteId: null,      // 当前打开的笔记 id
  dirty: false,      // 编辑器是否有未保存修改
  saving: false,
  filter: '',
  device: '',
  lastClipJson: '',
  lastNoteJson: '',
};

/* ---------- 基础工具 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  return d.toDateString() === now.toDateString()
    ? '今天 ' + hm
    : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
let toastTimer = null;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 1800);
}
function setSync(text, bad) {
  const el = $('syncStatus');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
}
function guessDevice() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : 'Web';
  const br = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : '浏览器';
  return br + '·' + os;
}

/* ---------- API ---------- */
async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts, {
    headers: Object.assign({}, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers),
  }));
  if (res.status === 401) {
    showLogin();
    const e = new Error('需要访问码');
    e.auth = true;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

async function loadData() {
  try {
    const d = await api('/api/data');
    const clipJson = JSON.stringify(d.clips);
    const noteJson = JSON.stringify(d.notes);
    state.clips = d.clips;
    state.notes = d.notes;
    setSync('已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    if (clipJson !== state.lastClipJson || noteJson !== state.lastNoteJson) {
      state.lastClipJson = clipJson;
      state.lastNoteJson = noteJson;
      renderClips();
      renderNotes();
    }
  } catch (e) {
    if (!e.auth) setSync('同步失败', true);
    throw e;
  }
}

/* ---------- 登录 ---------- */
function showLogin() {
  $('loginOverlay').classList.remove('hidden');
  if (!$('loginCode').value) $('loginCode').focus();
}
async function doLogin() {
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ code: $('loginCode').value }),
    });
    if (r.ok) {
      $('loginOverlay').classList.add('hidden');
      $('loginErr').textContent = '';
      $('loginCode').value = '';
      await loadData();
    }
  } catch (e) {
    $('loginErr').textContent = e.message;
  }
}

/* ---------- 剪切板 ---------- */
function renderClips() {
  const kw = state.filter.trim().toLowerCase();
  const list = state.clips.filter((c) => !kw || String(c.content).toLowerCase().includes(kw));
  const box = $('clipList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无内容</div>';
    return;
  }
  box.innerHTML = list.map((c) => `
    <div class="clip${c.pinned ? ' pinned' : ''}" data-id="${c.id}">
      <div class="clip-body">${esc(c.content)}</div>
      <div class="clip-meta">
        <span class="time">${fmtTime(c.created_at)}</span>
        ${c.device ? `<span class="tag">${esc(c.device)}</span>` : ''}
        ${c.pinned ? '<span class="tag pin">📌 已置顶</span>' : ''}
        <span class="spacer"></span>
        <button class="act" data-act="copy">复制</button>
        <button class="act" data-act="pin">${c.pinned ? '取消置顶' : '置顶'}</button>
        <button class="act danger" data-act="del">删除</button>
      </div>
    </div>`).join('');
}

async function sendClip() {
  const content = $('clipInput').value;
  if (!content.trim()) return;
  try {
    await api('/api/clips', {
      method: 'POST',
      body: JSON.stringify({ content, device: state.device }),
    });
    $('clipInput').value = '';
    await loadData();
    toast('已同步到云端');
  } catch (e) {
    if (!e.auth) toast(e.message, true);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制到本机剪切板');
}

/* ---------- 笔记本 ---------- */
function renderNotes() {
  const kw = state.filter.trim().toLowerCase();
  const list = state.notes.filter((n) => !kw || String(n.title || '').toLowerCase().includes(kw));
  const box = $('noteList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无笔记</div>';
    return;
  }
  box.innerHTML = list.map((n) => `
    <div class="note-item${String(n.id) === String(state.noteId) ? ' active' : ''}" data-id="${n.id}">
      <div class="note-item-title">${esc(n.title || '无标题')}</div>
      <div class="note-item-time">${fmtTime(n.updated_at)}</div>
    </div>`).join('');
}

async function openNote(id) {
  if (state.dirty) await saveNote();
  try {
    const n = await api('/api/notes/' + id);
    state.noteId = n.id;
    $('noteTitle').value = n.title;
    $('noteContent').value = n.content;
    state.dirty = false;
    $('noteSaveStatus').textContent = '编辑于 ' + fmtTime(n.updated_at);
    renderNotes();
  } catch (e) {
    if (!e.auth) toast(e.message, true);
  }
}

let saveTimer = null;
function onEdit() {
  if (!state.noteId) return;
  state.dirty = true;
  $('noteSaveStatus').textContent = '未保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNote, 900);
}

async function saveNote() {
  if (!state.noteId || state.saving || !state.dirty) return;
  state.saving = true;
  try {
    await api('/api/notes/' + state.noteId, {
      method: 'PUT',
      body: JSON.stringify({ title: $('noteTitle').value, content: $('noteContent').value }),
    });
    state.dirty = false;
    $('noteSaveStatus').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    await loadData();
  } catch (e) {
    if (!e.auth) toast('保存失败：' + e.message, true);
  } finally {
    state.saving = false;
  }
}

/* ---------- 标签页 ---------- */
function switchTab(tab) {
  state.tab = tab;
  $('tabClip').classList.toggle('active', tab === 'clip');
  $('tabNote').classList.toggle('active', tab === 'note');
  $('clipView').classList.toggle('hidden', tab !== 'clip');
  $('noteView').classList.toggle('hidden', tab !== 'note');
  $('searchBox').placeholder = tab === 'clip' ? '搜索剪切板…' : '搜索笔记标题…';
  renderClips();
  renderNotes();
}

/* ---------- 初始化 ---------- */
function bindEvents() {
  // 标签页
  $('tabClip').addEventListener('click', () => switchTab('clip'));
  $('tabNote').addEventListener('click', () => switchTab('note'));

  // 搜索
  $('searchBox').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderClips();
    renderNotes();
  });

  // 设备名
  const saved = localStorage.getItem('cn_device') || guessDevice();
  state.device = saved;
  $('deviceName').value = saved;
  $('deviceName').addEventListener('change', () => {
    const v = $('deviceName').value.trim() || guessDevice();
    state.device = v;
    localStorage.setItem('cn_device', v);
    $('deviceName').value = v;
  });

  // 剪切板
  $('sendClip').addEventListener('click', sendClip);
  $('clipInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendClip();
  });
  $('clipList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.clip').dataset.id;
    const clip = state.clips.find((c) => String(c.id) === id);
    if (!clip) return;
    try {
      if (btn.dataset.act === 'copy') {
        await copyText(clip.content);
      } else if (btn.dataset.act === 'pin') {
        await api('/api/clips/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: !clip.pinned }),
        });
        await loadData();
      } else if (btn.dataset.act === 'del') {
        if (!confirm('删除这条内容？')) return;
        await api('/api/clips/' + id, { method: 'DELETE' });
        await loadData();
        toast('已删除');
      }
    } catch (e) {
      if (!e.auth) toast(e.message, true);
    }
  });

  // 笔记本
  $('noteList').addEventListener('click', (ev) => {
    const item = ev.target.closest('.note-item');
    if (item) openNote(item.dataset.id);
  });
  $('noteTitle').addEventListener('input', onEdit);
  $('noteContent').addEventListener('input', onEdit);
  $('newNote').addEventListener('click', async () => {
    try {
      if (state.dirty) await saveNote();
      const n = await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title: '新建笔记', content: '' }),
      });
      await loadData();
      await openNote(n.id);
      $('noteTitle').select();
    } catch (e) {
      if (!e.auth) toast(e.message, true);
    }
  });
  $('delNote').addEventListener('click', async () => {
    if (!state.noteId || !confirm('删除当前笔记？')) return;
    try {
      await api('/api/notes/' + state.noteId, { method: 'DELETE' });
      state.noteId = null;
      state.dirty = false;
      $('noteTitle').value = '';
      $('noteContent').value = '';
      $('noteSaveStatus').textContent = '';
      await loadData();
      toast('已删除');
    } catch (e) {
      if (!e.auth) toast(e.message, true);
    }
  });

  // 手动刷新
  $('refreshBtn').addEventListener('click', () => {
    loadData().then(() => toast('已刷新')).catch(() => {});
  });

  // 登录
  $('loginBtn').addEventListener('click', doLogin);
  $('loginCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });

  // 轮询同步：页面可见时每 3 秒；从后台切回时立即刷新
  setInterval(() => {
    if (document.visibilityState === 'visible') loadData().catch(() => {});
  }, 3000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadData().catch(() => {});
  });
}

bindEvents();
loadData().catch(() => {});
