'use strict';

// ═══════════════════════════════════════════════════════
// SUPABASE CONFIG — the anon key is public, that is intended
// ═══════════════════════════════════════════════════════
const SUPABASE_URL  = 'https://wbztfmetvlbfysunuqks.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndienRmbWV0dmxiZnlzdW51cWtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzNDkyMDcsImV4cCI6MjA5OTkyNTIwN30.x10l_A83sE-kzxEB-iiOG_-3Wx_TjWYpR2tkSgnMzAw';

// Roles come from the login modal — the admin types a password
// Keep ADMIN_PASSWORD in your head only, never in the code
const APP_VERSION = '6.1';

const COLS = [
  {id:'todo',   label:'To Do',  color:'#9466e9'},
  {id:'doing',  label:'Doing',  color:'#FBBF24'},
  {id:'review', label:'Review', color:'#F472B6'},
  {id:'done',   label:'Done',   color:'#34D399'},
];

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let state = { cards:[], members:[], doneHistory:0 };
// let role  = null; // 'admin' | 'viewer'
let rowId = null; // Supabase row id
let dragId = null;
let editingCardId = null;
let editingCardVersion = 0;   // card version at the moment the modal was opened
let conflictState = null;     // server state that revealed the conflict
let editingMemberId = null;
let confirmCb  = null;
let activeMobileCol = 'todo';
let subtasks   = [];
let isSaving   = false;

// Auto-refresh
const POLL_MS  = 30000;  // background poll interval
const PULL_GAP = 2000;   // minimum gap between reads
let pollTimer      = null;
let lastRemoteJSON = null;  // copy of the last known server state, for comparison
let pendingRemote  = null;  // update deferred while the user is busy
let lastPullAt     = 0;
let persistSeq     = 0;     // write counter; marks reads started earlier as stale
let persistQueued  = false;


const PASS_ADMIN = 'game-admin';
const PASS_USER  = 'admin';

const ADMIN_IDS = [
  "mrrklu5wc0oj",
  "mrrkwzi7s4sx",
  "ms4kxnpq7w43"
];

let role = (loadSession() || {}).role || null;

// ═══════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════
function loadLocal(){
  try{ return JSON.parse(localStorage.getItem('gamefy_state')||'null'); }catch{ return null; }
}
function saveLocal(){
  try{ localStorage.setItem('gamefy_state', JSON.stringify(state)); }catch{}
}
function loadSession(){
  try{ return JSON.parse(localStorage.getItem('gamefy_session')||'null'); }catch{ return null; }
}
function saveSession(v){ try{ localStorage.setItem('gamefy_session', JSON.stringify(v)); }catch{} }
function isAdmin(){ return role === PASS_USER; }

// Normalizes an arbitrary object (from localStorage or Supabase) into the state shape
function normalizeState(obj){
  const s = { cards:[], members:[], doneHistory:0 };
  if(obj && typeof obj === 'object'){
    if(Array.isArray(obj.cards))            s.cards       = obj.cards;
    if(Array.isArray(obj.members))          s.members     = obj.members;
    if(typeof obj.doneHistory === 'number') s.doneHistory = obj.doneHistory;
  }
  return s;
}


 const dateInput = document.getElementById('f-deadline');
  dateInput.addEventListener('click', () => {
    dateInput.showPicker();
  });

// ═══════════════════════════════════════════════════════
// SUPABASE API
// ═══════════════════════════════════════════════════════
async function sbGet(){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kanban?select=id,data&limit=1`, {
    headers:{
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
    }
  });
  if(!res.ok) throw new Error('Supabase read error: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function sbUpdate(data){
  if(!rowId) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kanban?id=eq.${rowId}`, {
    method: 'PATCH',
    headers:{
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ data })
  });
  return res.ok;
}

async function sbInsert(data){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kanban`, {
    method: 'POST',
    headers:{
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ data })
  });
  if(!res.ok) throw new Error('Insert error: ' + res.status);
  const rows = await res.json();
  return rows[0];
}

// ═══════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  try{
    // Drop the cache on a new version
    if(localStorage.getItem('gamefy_version') !== APP_VERSION){
      const sess = localStorage.getItem('gamefy_session');
      localStorage.clear();
      if(sess) localStorage.setItem('gamefy_session', sess);
      localStorage.setItem('gamefy_version', APP_VERSION);
    }

    // Local cache
    state = normalizeState(loadLocal());

    // Restore the session
    const sess = loadSession();
    if(sess && sess.role){ role = sess.role; }

    setupEvents();

    if(role){
      showBoard();
    } else {
      showLoginModal(true);
      renderBoard();
      renderStats();
    }

  } catch(e){
    console.error('Boot error:', e);
    document.body.innerHTML = '<div style="color:#F87171;padding:40px;font-family:monospace;background:#0a0712;min-height:100vh">Ошибка загрузки: ' + e.message + '</div>';
  }
});

// ═══════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════
function showLoginModal(isFirst=false){
  el('login-modal-title').textContent = isFirst ? 'Добро пожаловать' : 'Смена роли';
  el('login-welcome').style.display   = isFirst ? '' : 'none';
  el('login-role-info').style.display = isFirst ? 'none' : '';
  el('login-cancel-btn').style.display = isFirst ? 'none' : '';
  el('gh-disconnect-btn').style.display = (!isFirst && role) ? '' : 'none';
  if(role) el('current-role-label').textContent = isAdmin() ? 'Администратор' : 'Участник команды';
  el('gh-token-input').value = '';
  el('gh-error').style.display = 'none';
  el('gh-save-btn').textContent = isFirst ? 'Войти' : 'Сохранить';
  openOverlay('github-overlay');
  setTimeout(()=> el('gh-token-input').focus(), 150);
}

function showBoard(){
  updateRoleBtn();

  // Demo data when empty
  if(!state.members.length){
    state.members = [
      {id:uid(), name:'Анна К.',   role:'UX/UI Designer', tg:'https://t.me/anna', avatar:''},
      {id:uid(), name:'Сергей М.', role:'Dev',            tg:'https://t.me/serg', avatar:''},
    ];
  }
  if(!state.cards.length){
    state.cards = [
      {id:uid(),title:'Главный экран',   type:'design',col:'todo', desc:'Разработать главный экран',link:'',subtasks:[{t:'Wireframe',done:true},{t:'Цвета',done:false}],  assignees:[state.members[0].id],deadline:'2025-08-10',version:1},
      {id:uid(),title:'API авторизации', type:'dev',   col:'doing',desc:'Endpoint для JWT',         link:'',subtasks:[{t:'User модель',done:true},{t:'Тесты',done:false}],assignees:[state.members[1].id],deadline:'2025-07-20',version:1},
    ];
  }

  render();
  setStatus('saving','Загрузка…');
  syncPull({force:true});
  startPolling();
}

// ═══════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════
function render(){
  renderBoard();
  renderMobileTabs();
  renderStats();
  saveLocal();
}

function renderStats(){
  el('done-count').textContent = state.doneHistory;
  const total = state.cards.length;
  const done  = state.cards.filter(c=>c.col==='done').length;
  const ratio = total ? done/total : 0;
  document.querySelectorAll('.progress-seg').forEach((seg,i)=>{
    seg.classList.toggle('filled', ratio >= (i+1)/5 - 0.001);
  });
}

function renderBoard(){

  const board = el('board');
  board.innerHTML = '';
  COLS.forEach(col => {
    const colCards = state.cards.filter(c=>c.col===col.id);
    const column = tpl('column-template');
    column.classList.toggle('mobile-active', col.id===activeMobileCol);
    column.dataset.col = col.id;
    slot(column,'indicator').style.background = col.color;
    slot(column,'name').textContent  = col.label;
    slot(column,'count').textContent = colCards.length;
    slot(column,'add').dataset.col   = col.id;

    const list = slot(column,'cards');
    list.id = 'cards-'+col.id;
    if(colCards.length){
      slot(list,'empty').remove();
      colCards.forEach(c => list.appendChild(cardNode(c)));
    }
    board.appendChild(column);
  });

  board.querySelectorAll('.col-add').forEach(btn =>
    btn.addEventListener('click', () => openCardModal(null, btn.dataset.col))
  );
  board.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-top-link')) {
        return;
      }
      openCardModal(card.dataset.id);
    })
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend',   onDragEnd);
  });
  board.querySelectorAll('.cards-list, .column').forEach(zone => {
    zone.addEventListener('dragover',  onDragOver);
    zone.addEventListener('dragleave', onDragLeave);
    zone.addEventListener('drop',      onDrop);
  });

  checkUrlCardParam()

  dataLinkCard()
}

function cardNode(c){
  const member = c.assignees && c.assignees.length
    ? state.members.find(m=>m.id===c.assignees[0]) : null;
  const done  = (c.subtasks||[]).filter(s=>s.done).length;
  const total = (c.subtasks||[]).length;
  const dlCls = deadlineCls(c.deadline);
  const dlLbl = c.deadline ? fmtDate(c.deadline) : '';
  const assigneeCount = (c.assignees||[]).length;

  const card = tpl('card-template');
  card.classList.toggle('task-hot', Boolean(c.hot));
  card.dataset.id = c.id;
  slot(card,'title').textContent = c.title;

  const tags = slot(card,'tags');
  if(c.type==='design' || c.type==='dev'){
    const tag = tpl('card-tag-template');
    tag.classList.add(c.type==='design' ? 'tag-design' : 'tag-dev');
    tag.textContent = c.type==='design' ? 'Design' : 'Dev';
    tags.appendChild(tag);
  }
  if(c.hot) tags.appendChild(tpl('card-tag-hot-template'));

  const layoutLink = (c.link||'').trim();
  if(layoutLink){
    const linkIcon = tpl('card-link-template');
    linkIcon.dataset.link = layoutLink;
    slot(card,'link').replaceWith(linkIcon);
  } else {
    slot(card,'link').remove();
  }

  if(total > 0){
    slot(card,'progress-label').textContent = `${done}/${total} подзадач`;
    const bar = slot(card,'progress-bar');
    for(let i = 0; i < total; i++){
      const seg = tpl('card-progress-seg-template');
      if(i < done) seg.classList.add('color-class');
      bar.appendChild(seg);
    }
  } else {
    slot(card,'progress').remove();
  }

  const assignee = slot(card,'assignee');
  if(assigneeCount === 0){
    assignee.replaceWith(tpl('card-assignee-none-template'));
  } else if(assigneeCount === 1 && member){
    const info = tpl('card-assignee-one-template');
    const name = slot(info,'name');
    name.setAttribute('href', member.tg || '#');
    name.textContent = member.name;
    slot(info,'role').textContent = member.role;
    assignee.replaceWith(info);
  } else {
    const info = tpl('card-assignee-many-template');
    slot(info,'count').textContent = `${assigneeCount} исполнителя`;
    slot(info,'names').textContent = `${member?.name||''}${assigneeCount>1?` +${assigneeCount-1}`:''}`;
    assignee.replaceWith(info);
  }

  const deadline = slot(card,'deadline');
  if(dlLbl){
    deadline.textContent = dlLbl;
    if(dlCls) deadline.classList.add(dlCls);
  } else {
    deadline.remove();
  }

  return card;
}

function renderMobileTabs(){
  COLS.forEach(col=>{
    const b = el('mtab-'+col.id);
    if(b) b.textContent = state.cards.filter(c=>c.col===col.id).length;
  });
}


const dataLinkCard = () => {
  const vewComplateElement = document.getElementById('toast');
  document.querySelectorAll('.card-top-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();

      const dataLink = btn.getAttribute('data-link');

      if(dataLink){
        navigator.clipboard.writeText(dataLink)
        .then(() => {
          
          vewComplateElement.textContent = 'Скопировано';
          vewComplateElement.classList.add('show', 'ok');

          setTimeout(() => {
            vewComplateElement.classList.remove('show', 'ok');
          }, 1500)
        })
      } else {
          console.log('erro copy link');
     
      }
    })
  })
}

// Copy icon next to the "Layout link" field: shown only when the field is filled in
function updateLinkCopyBtn(){
  el('f-link-copy').classList.toggle('show', Boolean(el('f-link').value.trim()));
}

function copyLayoutLink(){
  const link = el('f-link').value.trim();
  if(!link) return;
  navigator.clipboard.writeText(link)
    .then(()  => toast('Скопировано','ok'))
    .catch(() => toast('Не удалось скопировать','err'));
}

// ═══════════════════════════════════════════════════════
// DRAG & DROP
// ═══════════════════════════════════════════════════════
function onDragStart(e){
  dragId = e.currentTarget.dataset.id;
  const t = e.currentTarget;
  setTimeout(()=>{ if(t.isConnected) t.classList.add('dragging'); }, 0);
}
function onDragEnd(e){
  if(e.currentTarget.isConnected) e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.column').forEach(c=>c.classList.remove('drag-over'));
  dragId = null;
  flushPendingRemote();
}

function onDragOver(e){
  e.preventDefault();
  const col = e.currentTarget.closest('.column');
  if (!col) return;

  const cardsList = col.querySelector('.cards-list');
  const draggingCard = document.querySelector('.card.dragging');
  if (!draggingCard) return;

  const afterElement = getDragAfterElement(cardsList, e.clientY);

  if (afterElement == null) {
    cardsList.appendChild(draggingCard);
  } else {
    cardsList.insertBefore(draggingCard, afterElement);
  }

  document.querySelectorAll('.column').forEach(c=>c.classList.remove('drag-over'));
  if(col) col.classList.add('drag-over');
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 3;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}


function onDragLeave(e){
  const col = e.currentTarget.closest('.column');
  if(col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
}
function onDrop(e){
  e.preventDefault();
  const col = e.currentTarget.closest('.column');
  document.querySelectorAll('.column').forEach(c=>c.classList.remove('drag-over'));
  
  // if(col && dragId) moveCard(dragId, col.dataset.col);
  // dragId = null;
  if (!col || !dragId) {
    dragId = null;
    return;
  }

  const cardsList = col.querySelector('.cards-list');
  const targetColId = col.dataset.col;
  
  // Find the element the card was dropped in front of
  const afterElement = getDragAfterElement(cardsList, e.clientY);
  
  // Collect every card node in the column (except the dragged one)
  const cardsInCol = [...cardsList.querySelectorAll('.card:not(.dragging)')];
  
  let targetIndexInCol;
  if (afterElement == null) {
    // Dropped at the very end of the column
    targetIndexInCol = cardsInCol.length;
  } else {
    // Dropped in front of a specific element
    targetIndexInCol = cardsInCol.indexOf(afterElement);
  }

  moveCard(dragId, targetColId, targetIndexInCol);
  dragId = null;
}

// A drag does not check the version: blocking a drag with a modal would be too harsh.
// The change is applied on top of fresh state, so edits by other people are not lost.
async function moveCard(cardId, colId, targetIndexInCol = 0){
  const cardIndex = state.cards.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return;

  const card = state.cards[cardIndex];
  const prevCol = card.col;


  state.cards.splice(cardIndex, 1);
  card.col = colId;

  insertCardAtColIndex(state.cards, card, colId, targetIndexInCol);

  function insertCardAtColIndex(cardsArray, card, colId, colIndex) {
  let currentColCount = 0;
  let inserted = false;

  for (let i = 0; i < cardsArray.length; i++) {
    if (cardsArray[i].col === colId) {
      if (currentColCount === colIndex) {
        cardsArray.splice(i, 0, card);
        inserted = true;
        break;
      }
      currentColCount++;
    }
  }

  if (!inserted) {
    cardsArray.push(card);
  }
}

  if (colId === 'done' && prevCol !== 'done') state.doneHistory++;

  render();

  let reason = null, snapshot = null;
  const ok = await commit(fresh => {
    snapshot = fresh;
    
    // Find the card in the fresh state from the server
    const rcIndex = fresh.cards.findIndex(c => c.id === cardId);
    if (rcIndex === -1) { reason = 'gone'; return false; }
    
    const rc = fresh.cards[rcIndex];

    if (colId === 'done' && rc.col !== 'done') fresh.doneHistory++;
    
    // Pull it out of the server array
    fresh.cards.splice(rcIndex, 1);
    rc.col = colId;
    rc.version = (rc.version || 1) + 1;

    insertCardAtColIndex(fresh.cards, rc, colId, targetIndexInCol);
  });

  if (ok) { 
    toast('Перемещено'); 
    return; 
  }

  if (snapshot) {
    applyRemote(snapshot); 
  } else {
  
    if (colId === 'done' && prevCol !== 'done') state.doneHistory--;
    
    const curIdx = state.cards.findIndex(c => c.id === cardId);
    if (curIdx !== -1) state.cards.splice(curIdx, 1);
    
    card.col = prevCol;
    state.cards.splice(cardIndex, 0, card);
    render();
  }

  if (reason === 'gone')          toast('Карточку удалил другой участник', 'err');
  else if (reason === 'already')  toast('Карточка уже в этой колонке');
  else                            toast('Не удалось переместить', 'err');
}

// ═══════════════════════════════════════════════════════
// CARD MODAL
// ═══════════════════════════════════════════════════════
function openCardModal(id=null, colId='todo'){
  editingCardId = id;
  subtasks = [];
  const c = id ? state.cards.find(x=>x.id===id) : null;

  if (id) {
    const url = new URL(window.location);
    url.searchParams.set('card', id);
    history.replaceState(null, '', url);
  }

  // Cards created before versioning existed count as version one
  editingCardVersion = c ? (c.version || 1) : 0;
  hideCardConflict();
  el('card-modal-title').textContent = id ? 'Редактировать задачу' : 'Новая задача';
  el('delete-card-btn').style.display = (id && isAdmin()) ? '' : 'none';
  el('f-title').value    = c ? c.title      : '';
  el('f-link').value     = c ? c.link||''   : '';
  updateLinkCopyBtn();
  el('f-type').value     = c ? c.type||''   : '';
  el('f-col').value      = c ? c.col        : colId;
  el('f-desc').value     = c ? c.desc||''   : '';
  el('f-deadline').value = c ? c.deadline||'' : new Date().toISOString().slice(0,10);

  el('f-hot').checked    = c ? Boolean(c.hot) : false; 

  subtasks = c && c.subtasks ? JSON.parse(JSON.stringify(c.subtasks)) : [];
  renderSubtasks();
  renderAssigneePicker(c ? c.assignees||[] : []);
  openOverlay('card-overlay');
  setTimeout(()=>el('f-title').focus(), 100);
}

// kind: 'changed' — the card was edited; 'deleted' — it was removed; 'network' — no connection.
// fresh — server state; the up-to-date card is filled in from it afterwards.
function showCardConflict(kind, fresh){
  conflictState = fresh || null;
  const reload = el('card-reload-btn');
  const save   = el('save-card-btn');
  if(kind === 'changed'){
    el('card-conflict-text').textContent =
      'Карточка была изменена, сохранение невозможно. Нажми «Обновить», предварительно скопировав свои изменения.';
    reload.style.display = '';
    save.disabled = true;
  } else if(kind === 'deleted'){
    el('card-conflict-text').textContent =
      'Карточка была удалена, сохранение невозможно.';
    reload.style.display = 'none';
    save.disabled = true;
  } else {
    el('card-conflict-text').textContent =
      'Нет связи с сервером, изменения не сохранены. Проверь соединение и попробуй ещё раз.';
    reload.style.display = 'none';
    save.disabled = false;   // the network may be back, retrying makes sense
  }
  el('card-conflict').style.display = '';
}

// The card is gone from the server. The modal stays open: closing it means "saved",
// so reporting a failure with the same gesture would confuse. fresh is applied, otherwise
// the deleted card would stay on the board behind the modal.
function showDeletedCard(fresh){
  if(fresh){
    const pos = captureScroll();
    state = fresh;
    render();
    restoreScroll(pos);
  }
  showCardConflict('deleted');
}

function hideCardConflict(){
  const box = el('card-conflict');
  if(box) box.style.display = 'none';
  const save = el('save-card-btn');
  if(save) save.disabled = false;
  conflictState = null;
}


function reloadConflictCard(){
  if(!conflictState) return;
  const id = editingCardId;
  const pos = captureScroll();
  state = conflictState;
  render();
  restoreScroll(pos);
  if(state.cards.some(c => c.id === id)){
    openCardModal(id);            
    toast('Показана актуальная версия');
  } else {
    showDeletedCard();           
  }
}

function renderSubtasks(){
  const list = el('subtasks-list');
  list.innerHTML = '';
  subtasks.forEach((s,i)=>{
    const item  = tpl('subtask-template');
    const check = slot(item,'check');
    const text  = slot(item,'text');
    check.checked = Boolean(s.done);
    check.addEventListener('change',()=>{ subtasks[i].done = check.checked; renderSubtasks(); });
    text.textContent = s.t;
    text.classList.toggle('done-text', Boolean(s.done));
    slot(item,'del').addEventListener('click',()=>{ subtasks.splice(i,1); renderSubtasks(); });
    list.appendChild(item);
  });
}

let selectedAssignees = [];

function renderAssigneePicker(selected=[]){
  selectedAssignees = [...selected];
  renderAssigneeList();
  renderAssigneeDropdown();
}

function renderAssigneeList(){
  const list = el('assignee-list');
  if(!list) return;
  list.innerHTML = '';
  selectedAssignees.forEach(id=>{
    const m = state.members.find(x=>x.id===id);
    if(!m) return;
    const row = tpl('assignee-row-template');
    row.dataset.id = id;
    fillAvatar(slot(row,'avatar'), m);
    slot(row,'name').textContent = m.name;
    slot(row,'role').textContent = m.role;
    slot(row,'del').addEventListener('click', e=>{
      e.stopPropagation();
      selectedAssignees = selectedAssignees.filter(x=>x!==id);
      renderAssigneeList();
      renderAssigneeDropdown();
    });
    list.appendChild(row);
  });
}

function renderAssigneeDropdown(){
  const dd = el('assignee-dropdown');
  if(!dd) return;
  const available = state.members.filter(m=>!selectedAssignees.includes(m.id));
  if(!available.length){ dd.classList.remove('open'); return; }
  dd.innerHTML = '';
  available.forEach(m=>{
    const opt = tpl('assignee-option-template');
    opt.dataset.id = m.id;
    fillAvatar(slot(opt,'avatar'), m);
    slot(opt,'name').textContent = m.name;
    slot(opt,'role').textContent = m.role;
    opt.addEventListener('click', ()=>{
      selectedAssignees.push(m.id);
      dd.classList.remove('open');
      renderAssigneeList();
      renderAssigneeDropdown();
    });
    dd.appendChild(opt);
  });
}

function getSelectedAssignees(){
  return [...selectedAssignees];
}

async function saveCard(){
  const title = el('f-title').value.trim();
  if(!title){ el('f-title').focus(); return; }
  const data = {
    title, link:el('f-link').value.trim(), type:el('f-type').value,
    col:el('f-col').value, desc:el('f-desc').value.trim(),
    deadline:el('f-deadline').value,
    subtasks:JSON.parse(JSON.stringify(subtasks)),
    assignees:getSelectedAssignees(),
    hot: el('f-hot').checked,
  };

  hideCardConflict();
  const save = el('save-card-btn');
  save.disabled = true;   // guards against a second click while the check runs

  const id = editingCardId;
  let deletedState = null;
  const ok = await commit(fresh => {
    if(!id){
      fresh.cards.push({id:uid(), ...data, version:1});
      return;
    }
    const rc = fresh.cards.find(c => c.id === id);
    if(!rc){ deletedState = fresh; return false; }
    // The key check: the card changed since the modal was opened
    if((rc.version || 1) !== editingCardVersion){ showCardConflict('changed', fresh); return false; }
    if(data.col === 'done' && rc.col !== 'done') fresh.doneHistory++;
    Object.assign(rc, data, {version: (rc.version || 1) + 1});
  });

  if(ok){
    closeOverlay('card-overlay');
    hideCardConflict();
    toast('Сохранено','ok');
    return;
  }
  if(deletedState){ showDeletedCard(deletedState); return; }
  // commit failed and no reason was shown yet — so the connection dropped
  if(el('card-conflict').style.display === 'none') showCardConflict('network');
}

function deleteCard(){
  if(!editingCardId || !isAdmin()) return;
  const id = editingCardId;
  const title = state.cards.find(c=>c.id===id)?.title||'';
  showConfirm('Удалить задачу?',`«${title}» будет удалена безвозвратно.`, async ()=>{
    const ok = await commit(fresh => { fresh.cards = fresh.cards.filter(c=>c.id!==id); });
    if(ok){ closeOverlay('card-overlay'); toast('Удалено'); }
    else   toast('Не удалось удалить','err');
  });
}

// ═══════════════════════════════════════════════════════
// TEAM MODAL
// ═══════════════════════════════════════════════════════
function openTeamModal(){
  renderTeamList();
  el('add-member-btn').style.display = isAdmin() ? '' : 'none';
  openOverlay('team-overlay');
}

function renderTeamList(){
  const list = el('team-list');
  list.innerHTML = '';
  if(!state.members.length){
    list.appendChild(tpl('team-empty-template'));
    return;
  }

  state.members.forEach(m => {
    const openCnt = state.cards.filter(c => c.col !== 'done' && (c.assignees || []).includes(m.id)).length;
    const doneCnt = state.cards.filter(c => c.col === 'done' && (c.assignees || []).includes(m.id)).length;

    const row = tpl('team-member-template');
    row.dataset.id = m.id;
    fillAvatar(slot(row,'avatar'), m);

    const name = slot(row,'name');
    name.setAttribute('href', m.tg || '#');
    name.textContent = m.name;
    name.addEventListener('click', e => e.stopPropagation());
    slot(row,'role').textContent = m.role;

    if(openCnt){
      slot(row,'tasks-count').textContent = openCnt;
      slot(row,'no-tasks').remove();
    } else {
      slot(row,'tasks').remove();
    }
    slot(row,'done').textContent = `✓ ${doneCnt}`;

    const del = slot(row,'del');
    if(isAdmin()){
      del.addEventListener('click', e => {
        e.stopPropagation();
        showConfirm('Удалить участника?', `«${m.name||''}» будет удалён.`, async () => {
          const ok = await commit(fresh => {
            fresh.members = fresh.members.filter(x => x.id !== m.id);
            fresh.cards.forEach(c => { c.assignees = (c.assignees || []).filter(a => a !== m.id); });
          });
          renderTeamList();
          toast(ok ? 'Участник удалён' : 'Не удалось удалить', ok ? '' : 'err');
        });
      });
    } else {
      del.remove();
    }

    row.addEventListener('click', () => openEditMemberModal(m.id));
    list.appendChild(row);
  });
}

function openAddMemberModal(){
  editingMemberId=null;
  el('m-name').value=''; el('m-tg').value='';
  el('m-role').value='UX/UI Designer'; el('m-avatar').value='';
  openOverlay('add-member-overlay');
  setTimeout(()=>el('m-name').focus(),100);
}

async function saveMember(){
  const name=el('m-name').value.trim();
  if(!name){ el('m-name').focus(); return; }
  const data={name,tg:el('m-tg').value.trim(),role:el('m-role').value,avatar:el('m-avatar').value.trim()};
  const id = editingMemberId;
  const ok = await commit(fresh => {
    if(!id){ fresh.members.push({id:uid(),...data}); return; }
    const idx = fresh.members.findIndex(m=>m.id===id);
   
    if(idx === -1) fresh.members.push({id,...data});
    else           fresh.members[idx] = {...fresh.members[idx],...data};
  });
  if(!ok){ toast('Не удалось сохранить','err'); return; }
  closeOverlay('add-member-overlay');
  renderTeamList();
  toast('Участник сохранён','ok');
}


function openEditMemberModal(id){
  const m = state.members.find(x => x.id === id);
  if (!m) return;

  editingMemberId = id; 
  el('add-member-title').textContent = 'Редактирование участника';
  
  // Fill the form with the current data
  el('m-name').value   = m.name || '';
  el('m-tg').value     = m.tg || '';
  el('m-role').value   = m.role || 'UX/UI Designer';
  el('m-avatar').value = m.avatar || '';

  openOverlay('add-member-overlay');
  setTimeout(() => el('m-name').focus(), 100);
}

// ═══════════════════════════════════════════════════════
// LOGIN — the password sets the role and is kept in memory only
// ═══════════════════════════════════════════════════════
let currentSession = loadSession() || { role: 'user', loggedIn: false };

function doLogin(){
  const pass  = el('gh-token-input').value.trim();
  const errEl = el('gh-error');
  errEl.style.display = 'none';

  if(!pass){ 
    errEl.textContent = 'Введи пароль доступа'; 
    errEl.style.display = 'block'; 
    return; 
  }


  if(pass === PASS_ADMIN){
    role = 'admin';
  } 

  else if(pass === PASS_USER){
    role = 'viewer';
  } 

  else {
    errEl.textContent = 'Пароль не подходит. Обратись к администратору.';
    errEl.style.display = 'block';
    return;
  }

  // Save the session with the current role
  let session = loadSession() || {};
  saveSession({ ...session, role });


  closeOverlay('github-overlay');
  
  if (typeof updateRoleBtn === 'function') updateRoleBtn();
  if (typeof showBoard === 'function') showBoard();

  toast('Вход выполнен: ' + (isAdmin() ? 'Администратор' : 'Участник команды'), 'ok');
}

function simpleHash(str){
  let h = 0;
  for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; }
  return h.toString(36);
}

// ═══════════════════════════════════════════════════════
// SYNC
// ═══════════════════════════════════════════════════════
function startPolling(){
  stopPolling();
  pollTimer = setInterval(()=>{
    if(document.hidden) return;   // tab in the background: no request is sent
    syncPull({quiet:true});
  }, POLL_MS);
}
function stopPolling(){
  if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}

// The user is working with the board: re-rendering right now is not allowed
function isBusy(){
  if(isSaving || dragId) return true;
  return ['card-overlay','add-member-overlay','confirm-overlay']
    .some(id => el(id) && el(id).classList.contains('open'));
}

// renderBoard() rebuilds the whole DOM, so the scroll position is saved by hand.
// On desktop the columns scroll, on mobile (<=700px) the page itself does.
function captureScroll(){
  const m = { page: window.scrollY, cols:{} };
  COLS.forEach(c => { const n = el('cards-'+c.id); if(n) m.cols[c.id] = n.scrollTop; });
  return m;
}
function restoreScroll(m){
  COLS.forEach(c => { const n = el('cards-'+c.id); if(n && m.cols[c.id]) n.scrollTop = m.cols[c.id]; });
  if(m.page) window.scrollTo(0, m.page);
}

function applyRemote(remote){
  const pos = captureScroll();
  state = normalizeState(remote);
  render();
  restoreScroll(pos);
  if(el('team-overlay').classList.contains('open')) renderTeamList();
  setStatus('ok','Синхронизировано');
}

function flushPendingRemote(){
  if(!pendingRemote || isBusy()) return;
  const r = pendingRemote;
  pendingRemote = null;
  applyRemote(r);
}

// opts.quiet — background poll: the status changes only on a real change
// opts.force — manual refresh: runs bypassing the request rate limit
async function syncPull(opts={}){
  if(!role) return;
  const now = Date.now();
  if(!opts.force && now - lastPullAt < PULL_GAP) return;
  lastPullAt = now;

  const seq = persistSeq;
  try{
    const row = await sbGet();
    // A local write landed during the read: the response is stale and would return old data
    if(persistSeq !== seq) return;

    if(!row){
      // The table is empty — create the first row
      const row2 = await sbInsert(state);
      rowId = row2.id;
      lastRemoteJSON = JSON.stringify(state);
      setStatus('ok','База создана');
      return;
    }

    rowId = row.id;
    const json = JSON.stringify(row.data);
    if(json === lastRemoteJSON){
      if(!opts.quiet) setStatus('ok','Актуально');
      return;
    }
    lastRemoteJSON = json;

    if(isBusy()){
      pendingRemote = row.data;
      setStatus('ok','Есть обновления');
      return;
    }
    applyRemote(row.data);
  } catch(e){
    console.error('syncPull:', e);
    setStatus('error','Ошибка соединения');
  }
}

// Returns true if the state really was written to the server
async function persist(){
  if(!role) return false;
  // A write is already running — queue this one so it is not lost
  if(isSaving){ persistQueued = true; return true; }
  isSaving = true;
  persistSeq++;          // reads started before this point count as stale
  pendingRemote = null;  // the local write is newer than the deferred update
  setStatus('saving','Сохранение…');
  let ok = false;
  try{
    if(rowId){
      if(!await sbUpdate(state)) throw new Error('Supabase update failed');
    } else {
      const row = await sbInsert(state);
      rowId = row.id;
    }
    lastRemoteJSON = JSON.stringify(state);  // the next poll will return this very state
    setStatus('ok','Сохранено');
    ok = true;
  } catch(e){
    console.error('persist:', e);
    setStatus('error','Ошибка сохранения');
  } finally{
    isSaving = false;
    if(persistQueued){ persistQueued = false; ok = await persist(); }
    else flushPendingRemote();
  }
  return ok;
}

// The single write path. It reads fresh server state, applies one change on top of it
// and saves the result — that is why edits by other people are never overwritten.
// mutate(fresh) returns false to cancel the write (a conflict, or nothing to change).
async function commit(mutate){
  if(!role) return false;
  setStatus('saving','Проверка…');
  let row;
  try{
    row = await sbGet();
  } catch(e){
    console.error('commit:', e);
    setStatus('error','Нет связи с сервером');
    return false;
  }
  if(row) rowId = row.id;
  const fresh = normalizeState(row && row.data);
  let proceed;
  try{
    proceed = mutate(fresh);
  } catch(e){
    console.error('commit mutate:', e);
    setStatus('error','Ошибка при подготовке изменений');
    return false;
  }
  if(proceed === false){
    setStatus('ok','Актуально');
    return false;
  }
  const pos = captureScroll();
  state = fresh;
  render();
  restoreScroll(pos);
  return await persist();
}

// ═══════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════
function updateRoleBtn(){
  const btn = el('gh-settings-btn');
    
    if (!role) { 
      if (btn) {
        btn.textContent = 'Войти'; 
        btn.style.color = 'var(--text-secondary)'; 
      }
      applyAdminRestrictions(false); // Revoke admin rights
      return; 
    }

    const admin = isAdmin();

    if (btn) {
      btn.textContent = admin ? 'Админ' : 'Участник';
      btn.style.color = admin ? 'var(--text-primary)' : 'var(--dev)';
    }

    // Apply the UI restrictions
    applyAdminRestrictions(admin);
}

function applyAdminRestrictions(isUserAdmin) {

  const adminElements = document.querySelectorAll('.admin-only');
  adminElements.forEach(element => {
    if (isUserAdmin) {

      element.classList.remove('disabled', 'is-readonly');
      element.disabled = false;
      element.style.pointerEvents = 'auto';
      
    } else {
      element.classList.add('disabled', 'is-readonly');
      element.disabled = true;
      element.style.pointerEvents = 'none';

    }

  });
}

const observer = new MutationObserver(() => {
  applyAdminRestrictions(isAdmin());
});

// Watch the whole board / body
observer.observe(document.body, {
  childList: true,
  subtree: true
});


let isInitialUrlChecked = false;

function checkUrlCardParam() {

  if (isInitialUrlChecked) return;

  const urlParams = new URLSearchParams(window.location.search);
  const cardIdFromUrl = urlParams.get('card');

  if (cardIdFromUrl) {
    const cardExists = state.cards && state.cards.some(c => c.id === cardIdFromUrl);
    
    if (cardExists) {
      isInitialUrlChecked = true;
      openCardModal(cardIdFromUrl);
    } else {
      isInitialUrlChecked = true;
      console.warn('Карточка из URL не найдена');
    }
  }
}

// ═══════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════
function setupEvents(){
  document.querySelectorAll('[data-close]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id = btn.dataset.close;
      if(id==='github-overlay' && !role) return;
      closeOverlay(id);
    });
  });
  document.querySelectorAll('.overlay').forEach(ov=>{
    ov.addEventListener('click',e=>{
      if(e.target!==ov) return;
      if(ov.id==='github-overlay' && !role) return;
      closeOverlay(ov.id);
    });
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      document.querySelectorAll('.overlay.open').forEach(o=>{
        if(o.id==='github-overlay' && !role) return;
        closeOverlay(o.id);
      });
    }
  });

  // Coming back to the tab pulls state right away, without waiting for the next tick.
  // visibilitychange and focus often fire as a pair — PULL_GAP cuts off the duplicate request.
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) syncPull({quiet:true}); });
  window.addEventListener('focus',()=> syncPull({quiet:true}));

  el('gh-save-btn').addEventListener('click', doLogin);
  el('gh-token-input').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  el('gh-disconnect-btn').addEventListener('click',()=>{
    role = null;
    stopPolling();
    lastRemoteJSON = null;
    pendingRemote  = null;
    localStorage.removeItem('gamefy_session');
    closeOverlay('github-overlay');
    showLoginModal(true);
    updateRoleBtn();
    toast('Вы вышли');
  });
  el('gh-settings-btn').addEventListener('click',()=> showLoginModal(false));
  el('team-btn').addEventListener('click', openTeamModal);

  // Click on the status = refresh
  el('sync-status').style.cursor='pointer';
  el('sync-status').title='Нажми для обновления';
  el('sync-status').addEventListener('click', ()=> syncPull({force:true}));

  el('save-card-btn').addEventListener('click', saveCard);
  el('f-link').addEventListener('input', updateLinkCopyBtn);
  el('f-link-copy').addEventListener('click', copyLayoutLink);
  el('card-reload-btn').addEventListener('click', reloadConflictCard);
  el('delete-card-btn').addEventListener('click', deleteCard);
  el('subtask-add-btn').addEventListener('click', addSubtask);
  el('subtask-input').addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();addSubtask();} });
  el('add-member-btn').addEventListener('click', openAddMemberModal);
  el('assignee-add-btn').addEventListener('click', ()=>{
    const dd = el('assignee-dropdown');
    renderAssigneeDropdown();
    dd.classList.toggle('open');
  });
  // Close dropdown on outside click
  document.addEventListener('click', e=>{
    if(!e.target.closest('#assignee-dropdown') && !e.target.closest('#assignee-add-btn')){
      const dd = el('assignee-dropdown');
      if(dd) dd.classList.remove('open');
    }
  });
  el('save-member-btn').addEventListener('click', saveMember);
  el('confirm-ok-btn').addEventListener('click',()=>{
    closeOverlay('confirm-overlay');
    if(confirmCb){ confirmCb(); confirmCb=null; }
  });
  el('help-fab').addEventListener('click',()=>openOverlay('help-overlay'));
  el('mobile-tabs').addEventListener('click',e=>{
    const tab=e.target.closest('.mobile-tab');
    if(!tab) return;
    activeMobileCol=tab.dataset.col;
    document.querySelectorAll('.mobile-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    renderBoard();
  });
}

function addSubtask(){
  const inp=el('subtask-input');
  const v=inp.value.trim();
  if(!v) return;
  subtasks.push({t:v,done:false});
  inp.value=''; renderSubtasks(); inp.focus();
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
function openOverlay(id){ el(id).classList.add('open'); }
function closeOverlay(id){ 
  el(id).classList.remove('open'); 
  flushPendingRemote(); 

  const url = new URL(window.location);
  url.searchParams.delete('card');
  history.replaceState(null, '', url);
}

function showConfirm(title,text,cb){
  el('confirm-title').textContent=title;
  el('confirm-text').textContent=text;
  confirmCb=cb; openOverlay('confirm-overlay');
}
function setStatus(s,text){
  const dot=el('sync-dot'); const txt=el('sync-text');
  if(dot) dot.className='sync-dot '+s;
  if(txt) txt.textContent=text;
}
function el(id){ return document.getElementById(id); }
function tpl(id){ return el(id).content.firstElementChild.cloneNode(true); }
function slot(root, name){ return root.querySelector(`[data-slot="${name}"]`); }
// Member avatar: the image when set, otherwise the first letter of the name
function fillAvatar(node, m){
  if(m.avatar){
    const img = tpl('avatar-img-template');
    img.src = m.avatar;
    node.appendChild(img);
  } else {
    node.textContent = (m.name||'?')[0].toUpperCase();
  }
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(d){ if(!d) return ''; const [y,m,day]=d.split('-'); return `${day}.${m}.${y}`; }
function deadlineCls(dl){
  if(!dl) return '';
  const diff=(new Date(dl)-new Date())/(1000*60*60*24);
  if(diff<0) return 'overdue';
  if(diff<3) return 'soon';
  return '';
}
let toastT=null;
function toast(msg,type=''){
  const t=el('toast'); t.textContent=msg;
  t.className='toast show'+(type?' '+type:'');
  clearTimeout(toastT); toastT=setTimeout(()=>t.className='toast',2500);
}
