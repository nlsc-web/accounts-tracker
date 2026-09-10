const STAGES = [
  {key:'bank', label:'Bank Statement Entry'},
  {key:'invoices', label:'Invoice Entry'},
  {key:'receipts', label:'Receipt Entry'},
  {key:'voucher', label:'Payment Voucher Entry'},
  {key:'other', label:'Other Documents Entry'},
  {key:'finstmt', label:'Financial Statements & Tax Working'},
  {key:'audit', label:'Audit Report & Management Letter'},
  {key:'ramis', label:'RAMIS Submission'},
  {key:'clientscan', label:'Client Document Scanning'}
];
const STAMP_TEXT = {pending:'PENDING', progress:'IN PROG.', done:'DONE'};
const FALLBACK_USERS = [
  { name: 'Mrs.Lakmali', role: 'viewer', viewAll: true },
  { name: 'Ms.Sajini', role: 'entry', viewAll: true },
  { name: 'Mr.Denuwan', role: 'entry', viewAll: true },
  { name: 'Dilan', role: 'entry' },
  { name: 'Dilini', role: 'entry' },
  { name: 'Malik', role: 'entry' },
  { name: 'Asjath', role: 'entry' }
];

let jobs = [];
let activityLog = [];
let currentUser = '';
let currentRole = '';
let currentViewAll = false;
let timeEntries = [];
let worklogNameFilter = '';
let timerNameFilter = '';
let pollTimer = null;
let clockTimer = null;

function todayISO(){
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
}
function fmtDate(iso){
  if(!iso) return '';
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'});
}
function formatClock(ms){
  const n = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}
function fmtClockTime(ts){
  return new Date(ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
}
function myRunningTimer(){
  return timeEntries.find((e) => e.running && e.actor === currentUser) || null;
}
function formatDuration(ms){
  const n = Number(ms);
  if(!Number.isFinite(n) || n <= 0) return '';
  const totalMin = Math.round(n / 60000);
  if(totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if(h && m) return h + 'h ' + m + 'm';
  if(h) return h + 'h';
  return m + 'm';
}
function durationLabel(entry){
  if(entry.status === 'progress') return { text: 'started', cls: 'started' };
  if(entry.status === 'done'){
    const text = formatDuration(entry.durationMs);
    return text ? { text, cls: '' } : { text: '', cls: '' };
  }
  return { text: '', cls: '' };
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function isViewer(){
  return currentRole === 'viewer';
}
function canViewAll(){
  return currentViewAll === true;
}
function apiFetch(url, opts){
  return fetch(url, Object.assign({ credentials: 'include' }, opts || {}));
}

function setSyncStatus(state, message){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  el.classList.remove('ok','saving','error');
  el.onclick = null;
  if(state === 'saving'){
    el.classList.add('saving');
    el.textContent = message || 'Saving…';
  }else if(state === 'error'){
    el.classList.add('error');
    el.textContent = message || 'Sync failed — tap to retry';
    el.onclick = () => loadBoard();
  }else{
    el.classList.add('ok');
    el.textContent = message || 'Saved';
  }
}

function fillLoginUsers(list){
  const users = Array.isArray(list) && list.length ? list : FALLBACK_USERS;
  const sel = document.getElementById('loginName');
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled>Select name</option>';
  users.forEach(u => {
    const o = document.createElement('option');
    o.value = u.name;
    o.textContent = u.name + (u.role === 'viewer' ? ' (view)' : '');
    sel.appendChild(o);
  });
  if(current) sel.value = current;
  else sel.options[0].selected = true;
}

function applyRoleUI(){
  const viewer = isViewer();
  const viewAll = canViewAll();
  const newBtn = document.getElementById('newJobBtn');
  const hint = document.getElementById('legendHint');
  const headerSub = document.getElementById('headerSub');
  const staffGrp = document.getElementById('filterStaffGrp');
  const inStaff = document.getElementById('inStaff');
  if(newBtn) newBtn.style.display = viewer ? 'none' : '';
  if(staffGrp) staffGrp.style.display = viewAll ? '' : 'none';
  if(inStaff){
    inStaff.readOnly = !viewAll;
    inStaff.placeholder = viewAll ? 'e.g. Dilan' : '';
  }
  const worklogPanel = document.getElementById('worklogPanel');
  if(worklogPanel) worklogPanel.style.display = viewAll ? '' : 'none';
  const timerBar = document.getElementById('timerBar');
  if(timerBar) timerBar.style.display = viewer ? 'none' : '';
  if(hint) hint.textContent = viewer
    ? (viewAll ? 'View-only: you can see every job. Stamps cannot be changed from this account.' : 'View-only: stamps cannot be changed from this account.')
    : 'Click any stamp to cycle its status.';
  if(headerSub){
    headerSub.textContent = viewAll
      ? (viewer ? 'View-only · All staff · Daily Ledger' : 'All staff · Bookkeeping · Compliance')
      : 'Your jobs · Bookkeeping · Compliance';
  }
}

function showApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoamiName').textContent = currentUser;
  document.getElementById('todayDate').textContent = fmtDate(todayISO());
  document.getElementById('logDate').value = todayISO();
  applyRoleUI();
  loadBoard();
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadBoard, 15000);
  if(clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(tickTimers, 1000);
}

function jobIsComplete(job){
  return STAGES.every(s => job.stages[s.key] === 'done');
}

function populateFilterOptions(){
  const clientSel = document.getElementById('filterClient');
  const staffSel = document.getElementById('filterStaff');
  const curClient = clientSel.value;
  const curStaff = staffSel.value;
  const clients = [...new Set(jobs.map(j=>j.client).filter(Boolean))].sort();
  const staffs = [...new Set(jobs.map(j=>j.staff).filter(Boolean))].sort();
  clientSel.innerHTML = '<option value="">All</option>' + clients.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  staffSel.innerHTML = '<option value="">All</option>' + staffs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  clientSel.value = curClient;
  staffSel.value = curStaff;
}

function getFiltered(){
  const c = document.getElementById('filterClient').value;
  const s = document.getElementById('filterStaff').value;
  const st = document.getElementById('filterStatus').value;
  return jobs.filter(j=>{
    if(c && j.client !== c) return false;
    if(s && j.staff !== s) return false;
    if(st === 'complete' && !jobIsComplete(j)) return false;
    if(st === 'active' && jobIsComplete(j)) return false;
    return true;
  });
}

function renderStats(){
  const total = jobs.length;
  const complete = jobs.filter(jobIsComplete).length;
  const totalStages = jobs.length * STAGES.length;
  let doneStages = 0, progStages = 0;
  jobs.forEach(j => STAGES.forEach(s=>{
    if(j.stages[s.key]==='done') doneStages++;
    if(j.stages[s.key]==='progress') progStages++;
  }));
  const pct = totalStages ? Math.round((doneStages/totalStages)*100) : 0;
  const stats = [
    {n: total, l:'Open Client Jobs'},
    {n: complete, l:'Fully Completed'},
    {n: progStages, l:'Stages In Progress'},
    {n: pct + '%', l:'Overall Progress'}
  ];
  document.getElementById('statsRow').innerHTML = stats.map(s=>
    `<div class="stat-card"><div class="n">${s.n}</div><div class="l">${s.l}</div></div>`
  ).join('');
}

function renderScopeChips(el, names, byActor, filterValue, dataAttr){
  if(!el) return;
  if(!canViewAll()){
    const ms = byActor[currentUser] || 0;
    const dur = formatDuration(ms);
    el.innerHTML = dur
      ? `<span class="worklog-total active">${escapeHtml(currentUser)} <b>${dur}</b></span>`
      : '';
    return;
  }
  const allMs = Object.values(byActor).reduce((sum, n) => sum + n, 0);
  const allLabel = formatDuration(allMs);
  const allBtn = `<button type="button" class="worklog-total${filterValue === '' ? ' active' : ''}" ${dataAttr}="">All${allLabel ? ` <b>${allLabel}</b>` : ''}</button>`;
  const nameBtns = names.map(name => {
    const dur = formatDuration(byActor[name]);
    const active = filterValue === name ? ' active' : '';
    return `<button type="button" class="worklog-total${active}" ${dataAttr}="${escapeHtml(name)}">${escapeHtml(name)}${dur ? ` <b>${dur}</b>` : ''}</button>`;
  }).join('');
  el.innerHTML = allBtn + nameBtns;
}

function fillTimerJobs(){
  const sel = document.getElementById('timerJob');
  if(!sel) return;
  const running = myRunningTimer();
  const cur = running && running.jobId ? running.jobId : sel.value;
  sel.innerHTML = '<option value="">No client</option>' + jobs.map(j =>
    `<option value="${escapeHtml(j.id)}">${escapeHtml(j.client)}</option>`
  ).join('');
  if([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

function tickTimers(){
  const now = Date.now();
  const mine = myRunningTimer();
  const elapsed = document.getElementById('timerElapsed');
  if(elapsed) elapsed.textContent = formatClock(mine ? now - mine.startTs : 0);
  document.querySelectorAll('[data-live-start]').forEach(el => {
    el.textContent = formatClock(now - Number(el.dataset.liveStart));
  });
}

function renderTimer(){
  const dateVal = document.getElementById('logDate').value || todayISO();
  const list = document.getElementById('timerList');
  const totalsEl = document.getElementById('timerTotals');
  const liveEl = document.getElementById('timerLive');
  const bar = document.getElementById('timerBar');
  const toggle = document.getElementById('timerToggle');
  const noteInput = document.getElementById('timerNote');
  const jobSel = document.getElementById('timerJob');
  const mine = myRunningTimer();

  if(bar) bar.classList.toggle('running', Boolean(mine));
  if(toggle){
    toggle.textContent = mine ? 'Stop' : 'Start';
    toggle.classList.toggle('stop', Boolean(mine));
  }
  if(noteInput){
    noteInput.disabled = Boolean(mine);
    if(mine && document.activeElement !== noteInput) noteInput.value = mine.note || '';
  }
  if(jobSel) jobSel.disabled = Boolean(mine);
  tickTimers();

  const others = canViewAll()
    ? timeEntries.filter(e => e.running && e.actor !== currentUser)
    : [];
  if(liveEl){
    liveEl.innerHTML = others.map(e =>
      `${escapeHtml(e.actor)} tracking ${escapeHtml(e.client || e.note || 'time')} · <b data-live-start="${e.startTs}">${formatClock(Date.now() - e.startTs)}</b>`
    ).join('<br>');
  }

  const dayEntries = timeEntries.filter(e => e.date === dateVal || e.running);
  const byActor = {};
  const nameSet = new Set();
  dayEntries.forEach(e => {
    if(e.actor) nameSet.add(e.actor);
    const ms = e.running ? Date.now() - e.startTs : e.durationMs;
    byActor[e.actor] = (byActor[e.actor] || 0) + Number(ms || 0);
  });
  const names = [...nameSet].sort((a,b) => a.localeCompare(b));
  if(!canViewAll()) timerNameFilter = '';
  if(timerNameFilter && !nameSet.has(timerNameFilter)) timerNameFilter = '';
  renderScopeChips(totalsEl, names, byActor, timerNameFilter, 'data-timer-name');

  const shown = timerNameFilter
    ? dayEntries.filter(e => e.actor === timerNameFilter)
    : dayEntries;
  if(!list) return;
  if(shown.length === 0){
    list.innerHTML = `<div class="worklog-empty">No tracked time for ${fmtDate(dateVal)} yet. Press Start to begin.</div>`;
    return;
  }
  list.innerHTML = shown.map(e => {
    const endLabel = e.running ? 'now' : fmtClockTime(e.endTs);
    const dur = e.running
      ? `<span class="tdur" data-live-start="${e.startTs}">${formatClock(Date.now() - e.startTs)}</span>`
      : `<span class="tdur">${escapeHtml(formatDuration(e.durationMs) || formatClock(e.durationMs))}</span>`;
    const badge = e.running ? '<span class="tbadge">LIVE</span>' : '';
    const delBtn = isViewer() ? '' : `<button type="button" class="btn danger small" data-del-time="${escapeHtml(e.id)}" aria-label="Delete time entry">✕</button>`;
    return `<div class="timer-row">
      <span class="ttime">${fmtClockTime(e.startTs)} – ${endLabel}</span>
      <span class="tclient">${escapeHtml(e.client || '—')}</span>
      <span class="tnote">${escapeHtml(e.note || '')}</span>
      <span class="tactor">${escapeHtml(e.actor)}</span>
      ${badge}
      ${dur}
      ${delBtn}
    </div>`;
  }).join('');
}

function findStageLabel(key){
  const s = STAGES.find(x=>x.key===key);
  return s ? s.label : key;
}

function renderWorklog(){
  const dateInput = document.getElementById('logDate');
  const dateVal = dateInput.value || todayISO();
  const list = document.getElementById('worklogList');
  const totalsEl = document.getElementById('worklogTotals');
  const dayEntries = activityLog
    .filter(e => e.date === dateVal)
    .sort((a,b) => b.ts - a.ts);
  if(dayEntries.length === 0){
    list.innerHTML = `<div class="worklog-empty">No stage updates recorded for ${fmtDate(dateVal)} yet. As you click stamps on jobs, they'll log here.</div>`;
    if(totalsEl) totalsEl.innerHTML = '';
    worklogNameFilter = '';
    return;
  }
  const byActor = {};
  const nameSet = new Set();
  dayEntries.forEach(e => {
    if(e.actor) nameSet.add(e.actor);
    if(e.staff) nameSet.add(e.staff);
    if(e.status !== 'done' || !e.durationMs) return;
    const name = e.actor || 'Unknown';
    byActor[name] = (byActor[name] || 0) + Number(e.durationMs);
  });
  const names = [...nameSet].sort((a,b) => a.localeCompare(b));
  if(!canViewAll()) worklogNameFilter = '';
  if(worklogNameFilter && !nameSet.has(worklogNameFilter)) worklogNameFilter = '';
  renderScopeChips(totalsEl, names, byActor, worklogNameFilter, 'data-log-name');
  const entries = worklogNameFilter
    ? dayEntries.filter(e => e.actor === worklogNameFilter || e.staff === worklogNameFilter)
    : dayEntries;
  if(entries.length === 0){
    list.innerHTML = `<div class="worklog-empty">No updates for ${escapeHtml(worklogNameFilter)} on ${fmtDate(dateVal)}.</div>`;
    return;
  }
  list.innerHTML = entries.map(e => {
    const time = new Date(e.ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
    const actor = e.actor ? `<span class="wactor">${escapeHtml(e.actor)}</span>` : '';
    const dur = durationLabel(e);
    const durHtml = dur.text
      ? `<span class="wduration${dur.cls ? ' ' + dur.cls : ''}">${escapeHtml(dur.text)}</span>`
      : '<span class="wduration"></span>';
    return `<div class="worklog-row">
      <span class="wtime">${time}</span>
      <span class="wclient">${escapeHtml(e.client)}</span>
      <span class="wstaff">${escapeHtml(e.staff || 'Unassigned')}</span>
      ${actor}
      <span class="wstage">${escapeHtml(findStageLabel(e.stage))}</span>
      <span class="wstatus ${e.status}">${STAMP_TEXT[e.status] || e.status}</span>
      ${durHtml}
    </div>`;
  }).join('');
}

function render(){
  populateFilterOptions();
  fillTimerJobs();
  renderStats();
  renderTimer();
  if(canViewAll()) renderWorklog();
  const rows = document.getElementById('jobRows');
  const filtered = getFiltered();
  const empty = document.getElementById('emptyState');
  const viewer = isViewer();
  if(filtered.length === 0){
    rows.innerHTML = '';
    empty.style.display = 'block';
    const emptyMsg = document.getElementById('emptyStateMsg');
    if(emptyMsg){
      emptyMsg.textContent = canViewAll()
        ? 'No client jobs match this filter yet. Click "+ New Client Job" to open one.'
        : 'No jobs assigned to you yet. Click "+ New Client Job" to open one.';
    }
    document.getElementById('jobTable').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  document.getElementById('jobTable').style.display = 'table';

  rows.innerHTML = filtered.map(job => {
    const stageCells = STAGES.map(s=>{
      const status = job.stages[s.key];
      const readonly = viewer ? ' readonly' : '';
      return `<td><span class="stamp ${status}${readonly}" data-job="${job.id}" data-stage="${s.key}" title="${escapeHtml(s.label)} — click to change">${STAMP_TEXT[status]}</span></td>`;
    }).join('');
    const notesDisabled = viewer ? ' disabled' : '';
    const delBtn = viewer ? '' : `<button class="btn danger small" data-del="${job.id}" aria-label="Delete job">✕</button>`;
    return `<tr>
      <td class="client-cell">
        <div class="cname">${escapeHtml(job.client)}</div>
        <div class="meta">${escapeHtml(job.staff || 'Unassigned')} · ${fmtDate(job.date)}</div>
      </td>
      ${stageCells}
      <td class="notes-cell"><input type="text" value="${escapeHtml(job.notes||'')}" data-notes="${job.id}" placeholder="Add note…"${notesDisabled}></td>
      <td class="del-cell">${delBtn}</td>
    </tr>`;
  }).join('');
}

async function loadBoard(){
  try{
    const [jobsRes, logRes, timeRes] = await Promise.all([
      apiFetch('/api/jobs'),
      apiFetch('/api/activity?date=' + encodeURIComponent(document.getElementById('logDate').value || todayISO())),
      apiFetch('/api/time-entries?date=' + encodeURIComponent(document.getElementById('logDate').value || todayISO()))
    ]);
    if(jobsRes.status === 401){
      showLogin();
      return;
    }
    if(!jobsRes.ok) throw new Error('Failed to load jobs');
    jobs = await jobsRes.json();
    activityLog = logRes.ok ? await logRes.json() : [];
    timeEntries = timeRes.ok ? await timeRes.json() : [];
    render();
    setSyncStatus('ok', 'Saved');
  }catch(e){
    console.error(e);
    setSyncStatus('error');
  }
}

function showLogin(){
  if(pollTimer){
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if(clockTimer){
    clearInterval(clockTimer);
    clockTimer = null;
  }
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
}

async function restoreSession(){
  fillLoginUsers(FALLBACK_USERS);
  try{
    const usersRes = await apiFetch('/api/users');
    if(usersRes.ok) fillLoginUsers(await usersRes.json());
  }catch(e){
    console.error(e);
  }
  try{
    const meRes = await apiFetch('/api/me');
    if(!meRes.ok) return;
    const me = await meRes.json();
    currentUser = me.name || '';
    currentRole = me.role || '';
    currentViewAll = Boolean(me.viewAll);
    showApp();
  }catch(e){
    console.error(e);
  }
}

document.getElementById('loginBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('loginName').value;
  const pin = document.getElementById('loginPin').value.trim();
  const loginMsg = document.getElementById('loginMsg');
  if(!name){
    loginMsg.textContent = 'Please select your name.';
    loginMsg.style.display = 'block';
    return;
  }
  try{
    const res = await apiFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin })
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){
      loginMsg.textContent = data.error || 'Wrong PIN. Try again.';
      loginMsg.style.display = 'block';
      return;
    }
    loginMsg.style.display = 'none';
    document.getElementById('loginPin').value = '';
    currentUser = data.name || name;
    currentRole = data.role || '';
    currentViewAll = Boolean(data.viewAll);
    showApp();
  }catch(e){
    loginMsg.textContent = 'Could not reach the server.';
    loginMsg.style.display = 'block';
  }
});

document.getElementById('loginPin').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  try{ await apiFetch('/api/logout', { method: 'POST' }); }catch(e){}
  currentUser = '';
  currentRole = '';
  currentViewAll = false;
  worklogNameFilter = '';
  timerNameFilter = '';
  jobs = [];
  activityLog = [];
  timeEntries = [];
  showLogin();
});

document.getElementById('jobRows').addEventListener('click', async (e)=>{
  if(isViewer()) return;
  const stamp = e.target.closest('.stamp');
  if(stamp){
    const jobId = stamp.dataset.job;
    const stageKey = stamp.dataset.stage;
    setSyncStatus('saving');
    try{
      const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/stages/${encodeURIComponent(stageKey)}/cycle`, {
        method: 'POST'
      });
      if(!res.ok) throw new Error('Cycle failed');
      await loadBoard();
    }catch(err){
      console.error(err);
      setSyncStatus('error');
    }
    return;
  }
  const delBtn = e.target.closest('[data-del]');
  if(delBtn){
    const jobId = delBtn.dataset.del;
    const job = jobs.find(j=>j.id===jobId);
    if(job && confirm(`Delete job for "${job.client}"? This cannot be undone.`)){
      setSyncStatus('saving');
      try{
        const res = await apiFetch('/api/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' });
        if(!res.ok) throw new Error('Delete failed');
        await loadBoard();
      }catch(err){
        console.error(err);
        setSyncStatus('error');
      }
    }
  }
});

document.getElementById('jobRows').addEventListener('change', async (e)=>{
  const notesInput = e.target.closest('[data-notes]');
  if(!notesInput || isViewer()) return;
  const jobId = notesInput.dataset.notes;
  setSyncStatus('saving');
  try{
    const res = await apiFetch('/api/jobs/' + encodeURIComponent(jobId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesInput.value })
    });
    if(!res.ok) throw new Error('Notes save failed');
    const updated = await res.json();
    const idx = jobs.findIndex(j=>j.id===jobId);
    if(idx >= 0) jobs[idx] = updated;
    setSyncStatus('ok');
  }catch(err){
    console.error(err);
    setSyncStatus('error');
  }
});

['filterClient','filterStaff','filterStatus'].forEach(id=>{
  document.getElementById(id).addEventListener('change', render);
});
document.getElementById('logDate').addEventListener('change', loadBoard);
document.getElementById('worklogTotals').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-log-name]');
  if(!btn) return;
  worklogNameFilter = btn.getAttribute('data-log-name') || '';
  renderWorklog();
});
document.getElementById('timerList').addEventListener('click', async (e)=>{
  if(isViewer()) return;
  const delBtn = e.target.closest('[data-del-time]');
  if(!delBtn) return;
  const id = delBtn.getAttribute('data-del-time');
  const entry = timeEntries.find(t => t.id === id);
  const label = entry ? (entry.client || entry.note || 'this time entry') : 'this time entry';
  if(!confirm(`Delete time for "${label}"? This cannot be undone.`)) return;
  setSyncStatus('saving');
  try{
    const res = await apiFetch('/api/time-entries/' + encodeURIComponent(id), { method: 'DELETE' });
    if(!res.ok) throw new Error('Delete failed');
    await loadBoard();
  }catch(err){
    console.error(err);
    setSyncStatus('error');
  }
});
document.getElementById('timerTotals').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-timer-name]');
  if(!btn) return;
  timerNameFilter = btn.getAttribute('data-timer-name') || '';
  renderTimer();
});
document.getElementById('timerToggle').addEventListener('click', async ()=>{
  if(isViewer()) return;
  const running = myRunningTimer();
  setSyncStatus('saving');
  try{
    if(running){
      const res = await apiFetch('/api/timer/stop', { method: 'POST' });
      if(!res.ok) throw new Error('Stop failed');
    }else{
      const jobId = document.getElementById('timerJob').value;
      const note = document.getElementById('timerNote').value.trim();
      const res = await apiFetch('/api/timer/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, note })
      });
      if(!res.ok) throw new Error('Start failed');
    }
    await loadBoard();
  }catch(err){
    console.error(err);
    setSyncStatus('error');
  }
});
document.getElementById('timerNote').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !myRunningTimer() && !isViewer()){
    document.getElementById('timerToggle').click();
  }
});

const overlay = document.getElementById('modalOverlay');
document.getElementById('newJobBtn').addEventListener('click', ()=>{
  if(isViewer()) return;
  document.getElementById('inClient').value = '';
  document.getElementById('inStaff').value = currentUser || '';
  document.getElementById('inStaff').readOnly = !canViewAll();
  document.getElementById('inDate').value = todayISO();
  document.getElementById('modalErr').style.display = 'none';
  overlay.classList.add('open');
  document.getElementById('inClient').focus();
});
document.getElementById('cancelBtn').addEventListener('click', ()=> overlay.classList.remove('open'));
overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.classList.remove('open'); });

document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const client = document.getElementById('inClient').value.trim();
  const staff = document.getElementById('inStaff').value.trim();
  const date = document.getElementById('inDate').value || todayISO();
  if(!client){
    document.getElementById('modalErr').style.display = 'block';
    return;
  }
  setSyncStatus('saving');
  try{
    const res = await apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, staff, date })
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){
      document.getElementById('modalErr').textContent = data.error || 'Could not create job.';
      document.getElementById('modalErr').style.display = 'block';
      setSyncStatus('error');
      return;
    }
    overlay.classList.remove('open');
    await loadBoard();
  }catch(err){
    console.error(err);
    setSyncStatus('error');
  }
});

function getExportRows(){
  const header = ['Client','Staff','Date', ...STAGES.map(s=>s.label), 'Notes'];
  const rows = [header];
  getFiltered().forEach(j=>{
    rows.push([j.client, j.staff, j.date, ...STAGES.map(s=>STAMP_TEXT[j.stages[s.key]]), j.notes||'']);
  });
  return rows;
}
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function xmlEscape(s){
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.getElementById('exportExcelBtn').addEventListener('click', ()=>{
  const rows = getExportRows();
  const xmlRows = rows.map((row, i) => {
    const cells = row.map(v => `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('');
    const style = i === 0 ? ' ss:StyleID="Header"' : '';
    return `<Row${style}>${cells}</Row>`;
  }).join('');
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#C9A227"/><Interior ss:Color="#0A0A0A" ss:Pattern="Solid"/></Style>
</Styles>
<Worksheet ss:Name="Ledger">
<Table>${xmlRows}</Table>
</Worksheet>
</Workbook>`;
  downloadBlob(new Blob(['\uFEFF' + xml], {type:'application/vnd.ms-excel'}), `accounts-ledger-${todayISO()}.xls`);
});

document.getElementById('exportPdfBtn').addEventListener('click', ()=>{
  const rows = getExportRows();
  const thead = rows[0].map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows.slice(1).map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${rows[0].length}">No jobs to export.</td></tr>`;
  const w = window.open('', '_blank');
  if(!w){
    setSyncStatus('error', 'Allow pop-ups to export PDF');
    return;
  }
  w.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Accounts Ledger ${todayISO()}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #0a0a0a; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { color: #4a4a46; font-size: 12px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; }
  th { background: #0a0a0a; color: #c9a227; padding: 6px 5px; text-align: left; }
  td { border-bottom: 1px solid #e0ded8; padding: 5px; }
  tr:nth-child(even) td { background: #faf9f6; }
</style>
</head>
<body>
  <h1>Accounts Department — Daily Ledger</h1>
  <p class="sub">${escapeHtml(fmtDate(todayISO()))}${currentUser ? ' · ' + escapeHtml(currentUser) : ''}</p>
  <table>
    <thead><tr>${thead}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</body>
</html>`);
  w.document.close();
  w.focus();
  setTimeout(() => { try{ w.print(); }catch(e){} }, 300);
});

restoreSession();
