/* ═══════════════════════════════════════════════════════
   FIREBASE — compat mode (scripts loaded in HTML already)
═══════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey:            "AIzaSyD3P6WdxzPm2jDBkSeJ0DzywufAvypcmjo",
  authDomain:        "sym-inventory.firebaseapp.com",
  projectId:         "sym-inventory",
  storageBucket:     "sym-inventory.firebasestorage.app",
  messagingSenderId: "984361187387",
  appId:             "1:984361187387:web:dc2a56adcb1bef217e441e",
  measurementId:     "G-4GE9LWNNK4"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
// Guard against re-applying settings on hot-reload (fires the "overriding the original host" warning otherwise)
if (!window.__firestoreSettingsApplied) {
  db.settings({ ignoreUndefinedProperties: true }); // Firestore rejects `undefined` fields by default; RTDB didn't care
  window.__firestoreSettingsApplied = true;
}
const inventoryCol = db.collection('inventory');
let unsubscribeRealtime = null; // holds the Firestore onSnapshot() unsubscribe fn

/* ── FIREBASE HELPERS ── */
/* Formats a Date object as "YYYY-MM-DD" using LOCAL time (not UTC).
   toISOString() would use UTC, which flips the "day" over at 8:00 AM
   Philippine time instead of midnight — causing the wrong day's document
   to be read/written near the start/end of the business day. */
function formatLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDateKey() {
  return formatLocalDateKey(new Date()); // "YYYY-MM-DD" in local time
}

function getYesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatLocalDateKey(d);
}

/* Generic "N days ago" — used to search backward for the most recent
   day that actually has saved data, in case a day (or several) got skipped. */
function getDateKeyOffset(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatLocalDateKey(d);
}

function saveToFirebase() {
  const payload = {
    weeklyStock, arrivedStock, soldStock,
    arrivedLog, eodLog, customItems, customSections,
    weeklySubmitted, eodSubmitted,
    lastSaved: new Date().toISOString()
  };
  inventoryCol.doc(getDateKey()).set(payload)
    .then(() => showSyncBadge('✅ Saved to cloud'))
    .catch(err => showSyncBadge('❌ ' + err.message));
}

/*
  CARRY-OVER LOGIC
  ─────────────────
  When today has no data yet, we look at yesterday's node.
  For each item, the carry-over opening stock =
      yesterday's weeklyBase + arrivedStock - soldStock
  That becomes today's weeklyStock (the "opening balance").
  arrivedStock and soldStock start fresh at 0 for the new day.
  Custom items are also carried over so nothing is lost.
*/
function applyCarryOver(yesterday) {
  if (!yesterday) return;

  const prevWeekly  = yesterday.weeklyStock  || {};
  const prevArrived = yesterday.arrivedStock  || {};
  const prevSold    = yesterday.soldStock     || {};
  const prevCustom  = yesterday.customItems   || {};
  const prevSections = yesterday.customSections || {};

  Object.keys(DEPTS).forEach(dept => {
    if (!weeklyStock[dept]) weeklyStock[dept] = {};

    // Carry over custom sections so they aren't lost day-to-day
    if (prevSections[dept] && prevSections[dept].length) {
      if (!customSections[dept]) customSections[dept] = [];
      prevSections[dept].forEach(name => {
        if (!customSections[dept].includes(name)) customSections[dept].push(name);
      });
    }

    // Carry over custom items first so keys stay consistent
    if (prevCustom[dept] && prevCustom[dept].length) {
      if (!customItems[dept]) customItems[dept] = [];
      // Only add customs that don't already exist by name
      prevCustom[dept].forEach(item => {
        const exists = (customItems[dept] || []).some(c => c.name === item.name);
        if (!exists) customItems[dept].push(item);
      });
    }

    const allKeys = new Set([
      ...Object.keys(prevWeekly[dept]  || {}),
      ...Object.keys(prevArrived[dept] || {}),
      ...Object.keys(prevSold[dept]    || {}),
    ]);

    allKeys.forEach(key => {
      // Skip metadata keys
      if (key.startsWith('_')) return;
      const w = parseFloat((prevWeekly[dept]  || {})[key]) || 0;
      const a = parseFloat((prevArrived[dept] || {})[key]) || 0;
      const s = parseFloat((prevSold[dept]    || {})[key]) || 0;
      const remaining = w + a - s;
      // Only carry over if there was actual stock data
      if ((prevWeekly[dept] || {})[key] !== undefined) {
        weeklyStock[dept][key] = remaining;
        weeklySubmitted[dept]  = true; // mark as pre-filled
      }
    });
  });

  showSyncBadge('📦 Yesterday\'s closing stock loaded as today\'s opening');
}

function loadFromFirebase(callback) {
  showSyncBadge('🔄 Loading…');
  inventoryCol.doc(getDateKey()).get().then(docSnap => {
    const todayData = docSnap.exists ? docSnap.data() : null;
    if (todayData) {
      // Today already has data — just load it normally
      mergeState(todayData);
      showSyncBadge('✅ Data loaded');
      if (callback) callback();
    } else {
      // No data for today — search backward (up to 14 days) for the most
      // recent day that has data. This handles skipped days (e.g. the app
      // wasn't opened yesterday), so nothing entered a few days ago gets lost.
      findMostRecentPriorData(1, 14, (priorData, daysAgo) => {
        if (priorData) {
          applyCarryOver(priorData);
          // Save the carried-over opening balance as today's starting point
          saveToFirebase();
          showSyncBadge(daysAgo === 1
            ? '📦 Yesterday\'s closing stock loaded as today\'s opening'
            : `📦 Closing stock from ${daysAgo} days ago loaded as today's opening`);
        } else {
          showSyncBadge('ℹ️ No previous data found in the last 14 days — starting fresh');
        }
        if (callback) callback();
      });
    }
  }).catch(err => {
    showSyncBadge('❌ Load failed: ' + err.message);
    if (callback) callback();
  });
}

/* Walks backward day-by-day from `startDaysAgo` up to `maxDaysAgo`,
   returning the first day's data it finds (and how many days back it was). */
function findMostRecentPriorData(startDaysAgo, maxDaysAgo, cb) {
  inventoryCol.doc(getDateKeyOffset(startDaysAgo)).get().then(snap => {
    if (snap.exists) {
      cb(snap.data(), startDaysAgo);
    } else if (startDaysAgo >= maxDaysAgo) {
      cb(null, null);
    } else {
      findMostRecentPriorData(startDaysAgo + 1, maxDaysAgo, cb);
    }
  }).catch(() => cb(null, null));
}

function subscribeRealtime() {
  // Detach any previous listener first (e.g. if this ever gets called twice, or across day changes)
  if (unsubscribeRealtime) { unsubscribeRealtime(); unsubscribeRealtime = null; }
  unsubscribeRealtime = inventoryCol.doc(getDateKey()).onSnapshot(docSnap => {
    const d = docSnap.exists ? docSnap.data() : null;
    if (!d) return;
    mergeState(d);
    renderCurrentView();
    Object.keys(DEPTS).forEach(dk => updateBadge(dk));
    showSyncBadge('🔄 Synced');
  }, err => {
    showSyncBadge('❌ Sync error: ' + err.message);
  });
}

function mergeState(d) {
  Object.assign(weeklyStock,     d.weeklyStock     || {});
  Object.assign(arrivedStock,    d.arrivedStock    || {});
  Object.assign(soldStock,       d.soldStock       || {});
  Object.assign(customItems,     d.customItems     || {});
  Object.assign(customSections,  d.customSections  || {});
  Object.assign(weeklySubmitted, d.weeklySubmitted || {});
  Object.assign(eodSubmitted,    d.eodSubmitted    || {});
  arrivedLog.length = 0; (d.arrivedLog || []).forEach(e => arrivedLog.push(e));
  eodLog.length     = 0; (d.eodLog     || []).forEach(e => eodLog.push(e));
}

/* Sync badge — injected into .topbar-right by init */
function showSyncBadge(msg) {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3500);
}

/* ── THEME ── */
function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.getElementById('theme-btn').textContent = next === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('resort-theme', next);
}
(function initTheme() {
  const saved = localStorage.getItem('resort-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = saved === 'dark' ? '☀️' : '🌙';
  });
})();

/* ── DEPARTMENT DATA ──
   Predefined items removed on request — sections stay as empty groupings.
   Every item now gets added manually per department via "+ Add Item"
   in the Custom / Added Items part of the Weekly Stock form. */
const DEPTS = {
  housekeeping: {
    label: 'Housekeeping', icon: '🧹', eodTerm: 'Out',
    sections: [
      { name: 'Linens', items: [] },
      { name: 'Amenities', items: [] },
      { name: 'Cleaning Supplies', items: [] },
    ]
  },
  bar: {
    label: 'Bar', icon: '🍹',
    sections: [
      { name: 'Spirits', items: [] },
      { name: 'Beer & Wine', items: [] },
      { name: 'Mixers & Garnish', items: [] },
      { name: 'Consumables', items: [] },
    ]
  },
  kitchen: {
    label: 'Kitchen', icon: '🍽️',
    sections: [
      { name: 'Protein (Perishable)', items: [] },
      { name: 'Vegetables & Dairy', items: [] },
      { name: 'Dry Goods', items: [] },
    ]
  },
  pizzeria: {
    label: 'Pizzeria', icon: '🍕',
    sections: [
      { name: 'Dough & Base', items: [] },
      { name: 'Cheese & Toppings', items: [] },
      { name: 'Packaging', items: [] },
    ]
  }
};

/* ── IN-MEMORY STATE ── */
const weeklyStock     = {};
const arrivedStock    = {};
const soldStock       = {};
const arrivedLog      = [];
const eodLog          = [];
const customItems     = {};
const customSections  = {}; // { dept: ['Toiletries', 'Extra Supplies', ...] } — admin-added section names per department
const weeklySubmitted = {};
const eodSubmitted    = {};

let currentDept  = 'housekeeping';
let currentView  = 'form';   // matches HTML: 'form' | 'report'
let currentStep  = 'weekly'; // sub-tab inside form: 'weekly' | 'addstock' | 'eod'
const today      = new Date();
const deptKeys   = Object.keys(DEPTS);

/* ── HELPERS ── */
function getAllItems(dept) {
  const result = [];
  DEPTS[dept].sections.forEach((sec, si) => {
    sec.items.forEach((item, ii) => result.push({ sectionName: sec.name, item, si, ii, isCustom: false }));
  });
  (customItems[dept] || []).forEach((item, ii) => {
    result.push({ sectionName: 'Custom / Added Items', item, si: 99, ii, isCustom: true });
  });
  return result;
}

/* Returns every section available for a dept — predefined ones from DEPTS
   plus any admin-added custom sections — as { name, custom } objects. */
function getSectionsForDept(dept) {
  const predefined = DEPTS[dept].sections.map(s => ({ name: s.name, custom: false }));
  const customSecs = (customSections[dept] || []).map(name => ({ name, custom: true }));
  return predefined.concat(customSecs);
}

/* Buckets every custom item in a dept by which section it was placed into.
   Items whose section is missing or no longer exists fall into "unassigned"
   (shown as the "Custom / Added Items" catch-all). */
function groupCustomItemsBySection(dept) {
  const allCustoms   = customItems[dept] || [];
  const sectionNames = getSectionsForDept(dept).map(s => s.name);
  const bySection = {};
  sectionNames.forEach(n => { bySection[n] = []; });
  const unassigned = [];
  allCustoms.forEach((item, ii) => {
    if (item.section && bySection[item.section]) bySection[item.section].push({ item, ii });
    else unassigned.push({ item, ii });
  });
  return { bySection, unassigned };
}

/* Adds a brand-new section (e.g. "Toiletries") to a department. */
function addCustomSection(dept) {
  if (getUserDept() !== 'all') { alert('Only admin/manager accounts can add sections.'); return; }
  const input = document.getElementById(`new-section-name-${dept}`);
  const name  = (input || {}).value?.trim();
  if (!name) { alert('Please enter a section name.'); return; }
  const exists = getSectionsForDept(dept).some(s => normalizeItemName(s.name) === normalizeItemName(name));
  if (exists) { alert(`A section named "${name}" already exists.`); return; }
  if (!customSections[dept]) customSections[dept] = [];
  customSections[dept].push(name);
  if (input) input.value = '';
  saveToFirebase();
  renderWeeklyForm();
}

/* Removes an admin-added section. Any items placed in it fall back to
   "Custom / Added Items" rather than being deleted. */
function removeCustomSection(dept, idx) {
  if (getUserDept() !== 'all') { alert('Only admin/manager accounts can remove sections.'); return; }
  const secName = (customSections[dept] || [])[idx];
  if (!secName) return;
  const affected = (customItems[dept] || []).filter(it => it.section === secName);
  const msg = affected.length
    ? `Remove section "${secName}"? Its ${affected.length} item(s) will move back to "Custom / Added Items" — they will not be deleted.`
    : `Remove section "${secName}"?`;
  if (!confirm(msg)) return;
  affected.forEach(it => { it.section = ''; });
  customSections[dept].splice(idx, 1);
  saveToFirebase();
  renderWeeklyForm();
}

/* Normalizes a name for comparison so "Coke", " coke ", "COKE" all match */
function normalizeItemName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/* Returns every existing item name for a dept (predefined + custom), deduped */
function getAllItemNames(dept) {
  const names = [];
  DEPTS[dept].sections.forEach(sec => sec.items.forEach(item => names.push(item.name)));
  (customItems[dept] || []).forEach(item => names.push(item.name));
  const seen = new Set();
  return names.filter(n => {
    const key = normalizeItemName(n);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* Finds an existing item (predefined or custom) in a dept matching a name, or null */
function findExistingItem(dept, name) {
  const target = normalizeItemName(name);
  for (const sec of DEPTS[dept].sections) {
    const match = sec.items.find(item => normalizeItemName(item.name) === target);
    if (match) return match;
  }
  const customMatch = (customItems[dept] || []).find(item => normalizeItemName(item.name) === target);
  return customMatch || null;
}

function getRunningStock(dept, key) {
  const w = parseFloat((weeklyStock[dept]  || {})[key]) || 0;
  const a = parseFloat((arrivedStock[dept] || {})[key]) || 0;
  const s = parseFloat((soldStock[dept]    || {})[key]) || 0;
  return w + a - s;
}

function getStatus(qty, par) {
  if (qty === '' || qty === null || qty === undefined) return { label: '—', cls: 's-empty' };
  const n = parseFloat(qty);
  if (isNaN(n)) return { label: '—', cls: 's-empty' };
  const r = n / par;
  if (r <= 0.2) return { label: 'CRITICAL', cls: 's-critical' };
  if (r <= 0.5) return { label: 'LOW',      cls: 's-low'      };
  return            { label: 'OK',          cls: 's-ok'       };
}

function updateBadge(dept) {
  let hasCrit = false;
  getAllItems(dept).forEach(({ item, si, ii }) => {
    const key = `${si}_${ii}`;
    if ((weeklyStock[dept] || {})[key] !== undefined) {
      if (getStatus(getRunningStock(dept, key), item.par).cls === 's-critical') hasCrit = true;
    }
  });
  const badge = document.getElementById('badge-' + dept);
  if (!badge) return;
  if (!weeklySubmitted[dept]) { badge.textContent = '—'; badge.className = 'dept-badge'; return; }
  badge.textContent = hasCrit ? '⚠ Alert' : '✓ Done';
  badge.className   = 'dept-badge ' + (hasCrit ? 'has-alert' : 'done');
}

/* ── TOP-LEVEL VIEW SWITCHING (matches HTML btn-form / btn-report) ── */
function setView(view) {
  currentView = view;
  ['form', 'report', 'purchase-report', 'dashboard'].forEach(v => {
    const btn = document.getElementById('btn-' + v);
    if (btn) btn.classList.toggle('active', v === view);
  });
  renderCurrentView();
}

function setDept(dept) {
  if (!getAllowedDepts().includes(dept)) return; // ignore attempts to view a department this account isn't assigned to
  currentDept = dept;
  document.querySelectorAll('.dept-tab').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById('tab-' + dept);
  if (tab) tab.classList.add('active');
  renderCurrentView();
}

function setStep(step) {
  currentStep = step;
  renderCurrentView();
}

function renderCurrentView() {
  if (currentView === 'report')          { renderReport();             return; }
  if (currentView === 'purchase-report') { renderPurchaseOrderReport(); return; }
  if (currentView === 'dashboard')       { renderDashboard();          return; }
  // 'form' view — render sub-step
  if (currentStep === 'weekly')   renderWeeklyForm();
  else if (currentStep === 'addstock') renderAddStockForm();
  else renderEodForm();
}

function nextDept() {
  const allowed = getAllowedDepts();
  const cur = allowed.indexOf(currentDept);
  setDept(allowed[(cur + 1) % allowed.length]);
}

/* ── STEP TABS HTML (rendered at top of every form sub-view) ── */
function stepTabsHtml() {
  const steps = [
    { id: 'weekly',   label: '1 · Weekly Stock' },
    { id: 'addstock', label: '2 · Add Stock'    },
    { id: 'eod',      label: '3 · End of Day'   },
  ];
  return `<div class="step-tabs">` +
    steps.map(s => `<button class="step-tab${currentStep === s.id ? ' active' : ''}"
      onclick="setStep('${s.id}')">${s.label}</button>`).join('') +
    `</div>`;
}

/* ══════════════════════════════════════════
   STEP 1 — WEEKLY STOCK
══════════════════════════════════════════ */
function renderWeeklyForm() {
  const d    = DEPTS[currentDept];
  const saved = weeklyStock[currentDept] || {};
  const mc   = document.getElementById('main-content');

  if (weeklySubmitted[currentDept]) {
    mc.innerHTML = stepTabsHtml() + `
      <div class="success-card" style="display:block;max-width:500px;margin:2rem auto;">
        <div class="success-icon">✅</div>
        <h3>${d.label} weekly stock saved!</h3>
        <p>Stock counts recorded as the base inventory for this week.</p>
        <button class="next-btn"
          onclick="weeklySubmitted['${currentDept}']=false;renderWeeklyForm()">✏️ Edit</button>
        <button class="next-btn" style="margin-top:8px;"
          onclick="setStep('addstock')">➕ Add Arrived Stock →</button>
      </div>`;
    return;
  }

  let html = stepTabsHtml() + `
    <div class="section-header">
      <div>
        <h2>${d.icon} ${d.label} — Weekly Stock Entry</h2>
        <p>Encode all available stocks for this week.</p>
      </div>
      <div class="submitter-row">
        <input class="name-input" type="text" placeholder="Your name *" required
          id="wname-${currentDept}" value="${saved['_name'] || ''}">
      </div>
    </div>`;

  // Only admin/manager accounts (dept === 'all') can add/remove items and sections;
  // single-department accounts get a read-only view of the custom items list.
  const isAdmin = getUserDept() === 'all';

  // Reusable row renderer for any custom item, regardless of which section it lives in
  const customRow = (item, ii) => {
    const key = `99_${ii}`;
    const val = saved[key] !== undefined ? saved[key] : '';
    const st  = getStatus(val, item.par);
    return `<tr id="crow-${currentDept}-${ii}">
      <td><div class="item-name">${item.name}</div><div class="item-unit">${item.unit}</div></td>
      <td style="text-align:center">
        <input class="qty-input" type="number" min="0" step="0.5" placeholder="—" value="${val}"
          id="w-${currentDept}-99-${ii}"
          oninput="
            if(!weeklyStock['${currentDept}'])weeklyStock['${currentDept}']={};
            weeklyStock['${currentDept}']['${key}']=this.value;
            const s=getStatus(this.value,${item.par});
            const e=document.getElementById('wst-${currentDept}-99-${ii}');
            if(e){e.textContent=s.label;e.className='status-pill '+s.cls;}">
      </td>
      <td class="par-val">${item.par}</td>
      <td style="text-align:center">
        <span class="status-pill ${st.cls}" id="wst-${currentDept}-99-${ii}">${st.label}</span>
      </td>
      <td style="text-align:center">
        ${isAdmin ? `<button onclick="removeCustomItem('${currentDept}',${ii})"
          style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:16px;">✕</button>` : ''}
      </td></tr>`;
  };

  const { bySection, unassigned } = groupCustomItemsBySection(currentDept);

  // ➕ Add a new section — creates an empty grouping like "Linens" or "Bar" that
  // items can then be placed into via the "Add Item" form further down.
  if (isAdmin) {
    html += `<div class="inv-card">
      <div class="inv-card-head">➕ Add New Section</div>
      <div style="padding:12px 20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input class="name-input" type="text" placeholder="New section name (e.g. Toiletries)"
          id="new-section-name-${currentDept}" style="width:240px;"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addCustomSection('${currentDept}');}">
        <button class="submit-btn" style="padding:6px 14px;font-size:13px;"
          onclick="addCustomSection('${currentDept}')">+ Add Section</button>
      </div>
    </div>`;
  }

  // Predefined sections (Linens, Bar, Kitchen, etc. — built into the department)
  // plus any custom items an admin has placed into them.
  d.sections.forEach((sec, si) => {
    const customForSec = bySection[sec.name] || [];
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${sec.name}</div>
      <table class="inv-table">
        <thead><tr><th>Item</th><th style="width:140px;">Stock on hand</th><th style="width:80px;">Par</th><th style="width:110px;">Status</th><th style="width:40px;"></th></tr></thead>
        <tbody>`;
    sec.items.forEach((item, ii) => {
      const key = `${si}_${ii}`;
      const val = saved[key] !== undefined ? saved[key] : '';
      const st  = getStatus(val, item.par);
      html += `<tr>
        <td><div class="item-name">${item.name}</div><div class="item-unit">${item.unit}</div></td>
        <td style="text-align:center">
          <input class="qty-input" type="number" min="0" step="0.5" placeholder="—" value="${val}"
            id="w-${currentDept}-${si}-${ii}"
            oninput="
              if(!weeklyStock['${currentDept}'])weeklyStock['${currentDept}']={};
              weeklyStock['${currentDept}']['${key}']=this.value;
              const s=getStatus(this.value,${item.par});
              const e=document.getElementById('wst-${currentDept}-${si}-${ii}');
              if(e){e.textContent=s.label;e.className='status-pill '+s.cls;}">
        </td>
        <td class="par-val">${item.par}</td>
        <td style="text-align:center">
          <span class="status-pill ${st.cls}" id="wst-${currentDept}-${si}-${ii}">${st.label}</span>
        </td>
        <td></td></tr>`;
    });
    customForSec.forEach(({ item, ii }) => { html += customRow(item, ii); });
    if (!sec.items.length && !customForSec.length) {
      html += `<tr><td colspan="5" style="color:var(--text-muted);font-size:13px;">
        ${isAdmin ? `No items yet — add one below and place it in "${sec.name}".` : 'No items yet.'}
      </td></tr>`;
    }
    html += `</tbody></table></div>`;
  });

  // Admin-added custom sections
  (customSections[currentDept] || []).forEach((secName, csi) => {
    const items = bySection[secName] || [];
    html += `<div class="inv-card">
      <div class="inv-card-head" style="display:flex;align-items:center;justify-content:space-between;">
        <span>📦 ${secName}</span>
        ${isAdmin ? `<button onclick="removeCustomSection('${currentDept}',${csi})"
          style="background:none;border:1px solid var(--danger);color:var(--danger);
            border-radius:6px;padding:3px 10px;font-size:11px;font-weight:600;
            cursor:pointer;text-transform:none;letter-spacing:0;">🗑️ Remove Section</button>` : ''}
      </div>`;
    if (!items.length) {
      html += `<div style="padding:16px 20px;font-size:13px;color:var(--text-muted);">No items yet — add one below and place it in "${secName}".</div></div>`;
    } else {
      html += `<table class="inv-table">
        <thead><tr><th>Item</th><th style="width:140px;">Stock on hand</th><th style="width:80px;">Par</th><th style="width:110px;">Status</th><th style="width:40px;"></th></tr></thead>
        <tbody>`;
      items.forEach(({ item, ii }) => { html += customRow(item, ii); });
      html += `</tbody></table></div>`;
    }
  });

  // Catch-all bucket for items with no section (and the Add Item / Add Section controls)
  html += `<div class="inv-card">
    <div class="inv-card-head" style="display:flex;align-items:center;justify-content:space-between;">
      <span>➕ Custom / Added Items</span>
      ${getUserDept() === 'all' ? `
        <button onclick="resetAllCustomItems()"
          style="background:none;border:1px solid var(--danger);color:var(--danger);
            border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;
            cursor:pointer;text-transform:none;letter-spacing:0;">
          🗑️ Reset All Custom Items (all depts)
        </button>` : ''}
    </div>
    <table class="inv-table">
      <thead><tr><th>Item</th><th style="width:140px;">Stock on hand</th><th style="width:80px;">Par</th><th style="width:110px;">Status</th><th style="width:40px;"></th></tr></thead>
      <tbody id="custom-rows-${currentDept}">
        ${unassigned.length ? unassigned.map(({ item, ii }) => customRow(item, ii)).join('') :
          `<tr><td colspan="5" style="color:var(--text-muted);font-size:13px;">No unassigned items.</td></tr>`}
      </tbody>
    </table>
    <div style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--border);">
      ${isAdmin ? `
      <input class="name-input" type="text" placeholder="Start typing an item name…"
        id="new-item-name-${currentDept}" style="width:180px;" list="item-suggestions-${currentDept}"
        oninput="checkExistingItemName('${currentDept}')">
      <datalist id="item-suggestions-${currentDept}">
        ${getAllItemNames(currentDept).map(n => `<option value="${n}">`).join('')}
      </datalist>
      <input class="name-input" type="text" placeholder="Unit (e.g. pcs)"
        id="new-item-unit-${currentDept}" style="width:100px;">
      <input class="qty-input" type="number" min="0" placeholder="Par"
        id="new-item-par-${currentDept}" style="width:80px;">
      <select class="name-input" id="new-item-section-${currentDept}" style="width:190px;">
        <option value="">— Unassigned (Custom / Added Items) —</option>
        ${getSectionsForDept(currentDept).map(s => `<option value="${s.name}">${s.name}</option>`).join('')}
      </select>
      <button class="submit-btn" style="padding:6px 14px;font-size:13px;"
        onclick="addCustomItem('${currentDept}')">+ Add Item</button>
      ` : `<span style="font-size:13px;color:var(--text-muted);">Only admin/manager accounts can add new items. You can still update stock counts above.</span>`}
    </div>
    <div id="item-name-hint-${currentDept}" style="padding:0 16px 12px;font-size:12px;color:var(--warn);display:none;"></div>
    </div>`;

  html += `<div class="notes-section">
    <div class="notes-label">📝 Notes / Remarks</div>
    <textarea class="notes-area" placeholder="Notes about this week's stock…"
      id="wnotes-${currentDept}">${saved['_notes'] || ''}</textarea>
  </div>
  <div class="submit-row">
    <button class="submit-btn" onclick="submitWeekly('${currentDept}')">
      ✓ Save Weekly Stock for ${d.label}
    </button>
  </div>`;

  mc.innerHTML = html;
}

/* Live-checks the name field as the user types and warns if it matches an existing item */
function checkExistingItemName(dept) {
  const input = document.getElementById(`new-item-name-${dept}`);
  const hint  = document.getElementById(`item-name-hint-${dept}`);
  if (!input || !hint) return;
  const existing = findExistingItem(dept, input.value);
  if (existing) {
    hint.style.display = 'block';
    hint.textContent = `⚠️ "${existing.name}" already exists in the list — please pick it from the suggestions instead of adding it again.`;
  } else {
    hint.style.display = 'none';
    hint.textContent = '';
  }
}

function addCustomItem(dept) {
  if (getUserDept() !== 'all') { alert('Only admin/manager accounts can add items.'); return; }
  const nameInput = document.getElementById(`new-item-name-${dept}`);
  const name = (nameInput || {}).value?.trim();
  const unit = (document.getElementById(`new-item-unit-${dept}`) || {}).value?.trim() || 'pcs';
  const par  = parseFloat((document.getElementById(`new-item-par-${dept}`) || {}).value) || 1;
  const sectionSel = document.getElementById(`new-item-section-${dept}`);
  const section = sectionSel ? sectionSel.value : '';
  if (!name) { alert('Please enter an item name.'); return; }

  // Block duplicates: same item, different spelling/casing/spacing
  const existing = findExistingItem(dept, name);
  if (existing) {
    alert(`"${existing.name}" is already being tracked. Please use that item instead of adding a new one with a different name — this keeps the stock count from splitting across duplicates.`);
    if (nameInput) { nameInput.value = existing.name; }
    checkExistingItemName(dept);
    return;
  }

  if (!customItems[dept]) customItems[dept] = [];
  customItems[dept].push({ name, unit, par, section });
  saveToFirebase();
  renderWeeklyForm();
}

function removeCustomItem(dept, idx) {
  if (getUserDept() !== 'all') { alert('Only admin/manager accounts can remove items.'); return; }
  if (customItems[dept]) {
    customItems[dept].splice(idx, 1);
    if (weeklyStock[dept]) {
      const remaining = {};
      customItems[dept].forEach((_, ii) => {
        const oldKey = `99_${ii >= idx ? ii + 1 : ii}`;
        remaining[`99_${ii}`] = weeklyStock[dept][oldKey];
      });
      Object.keys(weeklyStock[dept]).filter(k => k.startsWith('99_')).forEach(k => delete weeklyStock[dept][k]);
      Object.assign(weeklyStock[dept], remaining);
    }
  }
  saveToFirebase();
  renderWeeklyForm();
}

/*
  Wipes every manually-added custom item — name, unit, par — and all of its
  weekly/arrived/sold stock entries, across ALL departments. Admin/manager only,
  since this touches departments a single-dept account can't even see.
  This does NOT touch the predefined catalog items (bed sheets, rum, etc.) —
  only the "Custom / Added Items" that were typed in by users.
*/
function resetAllCustomItems() {
  if (getUserDept() !== 'all') {
    alert('Only admin/manager accounts can reset custom items across all departments.');
    return;
  }
  const confirmed = confirm(
    'This will permanently delete every manually-added custom item — including its name, par level, and all recorded stock quantities — across ALL departments.\n\nThis cannot be undone. Continue?'
  );
  if (!confirmed) return;

  deptKeys.forEach(dept => {
    customItems[dept] = [];
    [weeklyStock, arrivedStock, soldStock].forEach(store => {
      if (!store[dept]) return;
      Object.keys(store[dept])
        .filter(k => k.startsWith('99_'))
        .forEach(k => delete store[dept][k]);
    });
  });

  saveToFirebase();
  renderCurrentView();
  deptKeys.forEach(dk => updateBadge(dk));
  showSyncBadge('🗑️ All custom items reset across every department');
}

/* Requires the submitter's name field to be filled in before a form can be saved.
   Focuses the field and shows an inline warning instead of silently defaulting to "Staff". */
function requireName(inputId) {
  const el = document.getElementById(inputId);
  const name = el ? el.value.trim() : '';
  if (!name) {
    alert('Please enter your name before saving.');
    if (el) {
      el.style.borderColor = 'var(--danger)';
      el.focus();
    }
    return null;
  }
  if (el) el.style.borderColor = '';
  return name;
}

function submitWeekly(dept) {
  const name = requireName('wname-' + dept);
  if (!name) return;
  if (!weeklyStock[dept]) weeklyStock[dept] = {};
  const d = DEPTS[dept];
  d.sections.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `${si}_${ii}`;
      const el  = document.getElementById(`w-${dept}-${si}-${ii}`);
      if (el && el.value !== '') weeklyStock[dept][key] = el.value;
    });
  });
  (customItems[dept] || []).forEach((_, ii) => {
    const key = `99_${ii}`;
    const el  = document.getElementById(`w-${dept}-99-${ii}`);
    if (el && el.value !== '') weeklyStock[dept][key] = el.value;
  });
  const notesEl = document.getElementById('wnotes-' + dept);
  weeklyStock[dept]['_name']  = name;
  weeklyStock[dept]['_notes'] = notesEl ? notesEl.value : '';
  weeklyStock[dept]['_time']  = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  weeklySubmitted[dept] = true;
  updateBadge(dept);
  saveToFirebase();
  setStep('addstock'); // jump straight into Add Arrived Stock after weekly stock is saved
}

/* ══════════════════════════════════════════
   STEP 2 — ADD ARRIVED STOCK
══════════════════════════════════════════ */
function renderAddStockForm() {
  const d  = DEPTS[currentDept];
  const mc = document.getElementById('main-content');

  let html = stepTabsHtml() + `
    <div class="section-header">
      <div>
        <h2>${d.icon} ${d.label} — Add Arrived Stock</h2>
        <p>Enter quantities received from today's delivery.</p>
      </div>
      <div class="submitter-row">
        <input class="name-input" type="text" placeholder="Your name *" required id="aname-${currentDept}">
      </div>
    </div>`;

  // Arrival history for this dept
  const deptLog = arrivedLog.filter(l => l.dept === d.label);
  if (deptLog.length > 0) {
    html += `<div class="inv-card" style="margin-bottom:1.25rem;">
      <div class="inv-card-head">📬 Today's Arrival History — ${d.label}</div>
      <table class="log-table">
        <thead><tr><th>Item</th><th>Qty Added</th><th>Time</th><th>By</th></tr></thead>
        <tbody>`;
    deptLog.forEach(l => {
      html += `<tr>
        <td>${l.item} <span style="font-size:12px;color:var(--text-muted);">${l.unit}</span></td>
        <td style="font-family:'DM Mono',monospace;color:var(--accent);">+${l.qty}</td>
        <td style="font-family:'DM Mono',monospace;font-size:13px;">${l.time}</td>
        <td>${l.name}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  }

  // Build sections in the same order/grouping as the Weekly Stock form:
  // predefined sections, then admin-added custom sections, then unassigned items.
  const { bySection, unassigned } = groupCustomItemsBySection(currentDept);
  const allSections = [];
  d.sections.forEach((sec, si) => {
    const entries = sec.items.map((item, ii) => ({ item, key: `${si}_${ii}` }));
    (bySection[sec.name] || []).forEach(({ item, ii }) => entries.push({ item, key: `99_${ii}` }));
    allSections.push({ name: sec.name, entries });
  });
  (customSections[currentDept] || []).forEach(secName => {
    const entries = (bySection[secName] || []).map(({ item, ii }) => ({ item, key: `99_${ii}` }));
    allSections.push({ name: secName, entries });
  });
  if (unassigned.length) {
    allSections.push({ name: 'Custom / Added Items', entries: unassigned.map(({ item, ii }) => ({ item, key: `99_${ii}` })) });
  }

  allSections.forEach(({ name, entries }) => {
    if (!entries.length) return; // nothing to add stock to in this section yet
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${name}</div>
      <table class="inv-table">
        <thead><tr><th>Item</th><th style="width:110px;">Current stock</th><th style="width:140px;">Add qty</th><th style="width:110px;">New total</th></tr></thead>
        <tbody>`;
    entries.forEach(({ item, key }) => {
      const [si, ii] = key.split('_');
      const running = getRunningStock(currentDept, key);
      const hasBase = (weeklyStock[currentDept] || {})[key] !== undefined;
      html += `<tr>
        <td><div class="item-name">${item.name}</div><div class="item-unit">${item.unit}</div></td>
        <td class="par-val">${hasBase ? running : '—'}</td>
        <td style="text-align:center">
          <input class="qty-input" type="number" min="0" step="0.5" placeholder="0"
            id="a-${currentDept}-${si}-${ii}"
            oninput="updateAddPreview('${currentDept}',${si},${ii})">
        </td>
        <td style="text-align:center">
          <span id="anew-${currentDept}-${si}-${ii}"
            style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent);">
            ${hasBase ? running : '—'}
          </span>
        </td></tr>`;
    });
    html += `</tbody></table></div>`;
  });

  html += `<div class="submit-row">
    <button class="submit-btn" onclick="submitArrived('${currentDept}')">
      + Save Arrived Stock for ${d.label}
    </button>
  </div>`;
  mc.innerHTML = html;
}

function updateAddPreview(dept, si, ii) {
  const key     = `${si}_${ii}`;
  const addVal  = parseFloat(document.getElementById(`a-${dept}-${si}-${ii}`).value) || 0;
  const running = getRunningStock(dept, key);
  const hasBase = (weeklyStock[dept] || {})[key] !== undefined;
  const el = document.getElementById(`anew-${dept}-${si}-${ii}`);
  if (el) el.textContent = hasBase ? running + addVal : `+${addVal}`;
}

function submitArrived(dept) {
  const d    = DEPTS[dept];
  const name = requireName('aname-' + dept);
  if (!name) return;
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (!arrivedStock[dept]) arrivedStock[dept] = {};
  let added = 0;

  d.sections.forEach((sec, si) => {
    sec.items.forEach((item, ii) => {
      const key = `${si}_${ii}`;
      const val = parseFloat((document.getElementById(`a-${dept}-${si}-${ii}`) || {}).value) || 0;
      if (val > 0) {
        arrivedStock[dept][key] = (parseFloat(arrivedStock[dept][key]) || 0) + val;
        arrivedLog.push({ dept: d.label, item: item.name, qty: val, unit: item.unit, time, name });
        added++;
      }
    });
  });
  (customItems[dept] || []).forEach((item, ii) => {
    const key = `99_${ii}`;
    const val = parseFloat((document.getElementById(`a-${dept}-99-${ii}`) || {}).value) || 0;
    if (val > 0) {
      arrivedStock[dept][key] = (parseFloat(arrivedStock[dept][key]) || 0) + val;
      arrivedLog.push({ dept: d.label, item: item.name, qty: val, unit: item.unit, time, name });
      added++;
    }
  });

  if (added === 0) { alert('No quantities entered. Please enter at least one.'); return; }
  updateBadge(dept);
  saveToFirebase();
  renderAddStockForm();
}

/* ══════════════════════════════════════════
   STEP 3 — END OF DAY
══════════════════════════════════════════ */
function renderEodForm() {
  const d    = DEPTS[currentDept];
  const saved = soldStock[currentDept] || {};
  const mc   = document.getElementById('main-content');
  const term = d.eodTerm || 'Sold';       // "Sold" for most depts, "Out" for Housekeeping
  const termVerb = term === 'Out' ? 'taken out' : 'sold/consumed';

  if (!weeklySubmitted[currentDept]) {
    mc.innerHTML = stepTabsHtml() + `
      <div class="success-card" style="display:block;max-width:500px;margin:2rem auto;">
        <div class="success-icon">⚠️</div>
        <h3>Weekly stock not yet set for ${d.label}</h3>
        <p>Complete Weekly Stock entry first.</p>
        <button class="next-btn" onclick="setStep('weekly')">Go to Weekly Stock →</button>
      </div>`;
    return;
  }

  if (eodSubmitted[currentDept]) {
    mc.innerHTML = stepTabsHtml() + `
      <div class="success-card" style="display:block;max-width:500px;margin:2rem auto;">
        <div class="success-icon">🌙</div>
        <h3>${d.label} end-of-day recorded!</h3>
        <p>${term} quantities saved. Check the report for remaining stock.</p>
        <button class="next-btn"
          onclick="eodSubmitted['${currentDept}']=false;renderEodForm()">✏️ Edit</button>
        <button class="next-btn" style="margin-top:8px;"
          onclick="setView('report')">📊 View Report</button>
      </div>`;
    return;
  }

  let html = stepTabsHtml() + `
    <div class="section-header">
      <div>
        <h2>${d.icon} ${d.label} — End-of-Day ${term} Inventory</h2>
        <p>Enter quantities ${termVerb} today. Remaining stock computed automatically.</p>
      </div>
      <div class="submitter-row">
        <input class="name-input" type="text" placeholder="Your name *" required
          id="ename-${currentDept}" value="${saved['_name'] || ''}">
      </div>
    </div>`;

  const renderEodSection = (entries) => {
    entries.forEach(({ item, key }) => {
      const [si, ii]  = key.split('_');
      const running   = getRunningStock(currentDept, key);
      const hasBase   = (weeklyStock[currentDept] || {})[key] !== undefined;
      const soldVal   = saved[key] !== undefined ? saved[key] : '';
      const remaining = (hasBase && soldVal !== '') ? running - (parseFloat(soldVal) || 0) : (hasBase ? running : '');
      const st        = hasBase ? getStatus(remaining !== '' ? remaining : running, item.par) : { label: '—', cls: 's-empty' };
      html += `<tr>
        <td><div class="item-name">${item.name}</div><div class="item-unit">${item.unit}</div></td>
        <td class="par-val">${hasBase ? running : '—'}</td>
        <td style="text-align:center">
          <input class="qty-input" type="number" min="0" step="0.5" placeholder="0"
            value="${soldVal}" id="e-${currentDept}-${si}-${ii}"
            oninput="updateEodRow('${currentDept}',${si},${ii},${item.par},${hasBase ? running : 0})">
        </td>
        <td style="text-align:center">
          <span id="erem-${currentDept}-${si}-${ii}"
            style="font-family:'DM Mono',monospace;font-size:13px;">
            ${remaining !== '' ? remaining : (hasBase ? running : '—')}
          </span>
        </td>
        <td style="text-align:center">
          <span class="status-pill ${st.cls}" id="est-${currentDept}-${si}-${ii}">${st.label}</span>
        </td></tr>`;
    });
  };

  const { bySection, unassigned } = groupCustomItemsBySection(currentDept);

  d.sections.forEach((sec, si) => {
    const entries = sec.items.map((item, ii) => ({ item, key: `${si}_${ii}` }));
    (bySection[sec.name] || []).forEach(({ item, ii }) => entries.push({ item, key: `99_${ii}` }));
    if (!entries.length) return; // nothing to report EOD stock for in this section yet
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${sec.name}</div>
      <table class="inv-table">
        <thead><tr>
          <th>Item</th><th style="width:100px;">Available</th><th style="width:140px;">Qty ${term.toLowerCase()}</th><th style="width:100px;">Remaining</th><th style="width:100px;">Status</th>
        </tr></thead><tbody>`;
    renderEodSection(entries);
    html += `</tbody></table></div>`;
  });

  (customSections[currentDept] || []).forEach(secName => {
    const entries = (bySection[secName] || []).map(({ item, ii }) => ({ item, key: `99_${ii}` }));
    if (!entries.length) return;
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${secName}</div>
      <table class="inv-table">
        <thead><tr>
          <th>Item</th><th style="width:100px;">Available</th><th style="width:140px;">Qty ${term.toLowerCase()}</th><th style="width:100px;">Remaining</th><th style="width:100px;">Status</th>
        </tr></thead><tbody>`;
    renderEodSection(entries);
    html += `</tbody></table></div>`;
  });

  if (unassigned.length) {
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 Custom / Added Items</div>
      <table class="inv-table">
        <thead><tr>
          <th>Item</th><th style="width:100px;">Available</th><th style="width:140px;">Qty ${term.toLowerCase()}</th><th style="width:100px;">Remaining</th><th style="width:100px;">Status</th>
        </tr></thead><tbody>`;
    renderEodSection(unassigned.map(({ item, ii }) => ({ item, key: `99_${ii}` })));
    html += `</tbody></table></div>`;
  }

  html += `<div class="notes-section">
    <div class="notes-label">📝 End-of-Day Notes</div>
    <textarea class="notes-area" placeholder="Items that ran out, wastage, special remarks…"
      id="enotes-${currentDept}">${saved['_notes'] || ''}</textarea>
  </div>
  <div class="submit-row">
    <button class="submit-btn" onclick="submitEod('${currentDept}')">
      🌙 Submit End-of-Day for ${d.label}
    </button>
  </div>`;

  mc.innerHTML = html;
}

function updateEodRow(dept, si, ii, par, available) {
  const soldVal   = parseFloat(document.getElementById(`e-${dept}-${si}-${ii}`).value) || 0;
  const remaining = available - soldVal;
  const st        = getStatus(remaining, par);
  const remEl     = document.getElementById(`erem-${dept}-${si}-${ii}`);
  const stEl      = document.getElementById(`est-${dept}-${si}-${ii}`);
  if (remEl) remEl.textContent = remaining;
  if (stEl)  { stEl.textContent = st.label; stEl.className = 'status-pill ' + st.cls; }
}

function submitEod(dept) {
  const d    = DEPTS[dept];
  const name = requireName('ename-' + dept);
  if (!name) return;
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (!soldStock[dept]) soldStock[dept] = {};

  d.sections.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `${si}_${ii}`;
      const el  = document.getElementById(`e-${dept}-${si}-${ii}`);
      soldStock[dept][key] = el ? (el.value || 0) : 0;
    });
  });
  (customItems[dept] || []).forEach((_, ii) => {
    const key = `99_${ii}`;
    const el  = document.getElementById(`e-${dept}-99-${ii}`);
    soldStock[dept][key] = el ? (el.value || 0) : 0;
  });

  const notesEl = document.getElementById('enotes-' + dept);
  soldStock[dept]['_name']  = name;
  soldStock[dept]['_notes'] = notesEl ? notesEl.value : '';
  soldStock[dept]['_time']  = time;
  eodSubmitted[dept] = true;
  eodLog.push({ dept: d.label, icon: d.icon, submitter: name, time });
  updateBadge(dept);
  saveToFirebase();
  renderEodForm();
}

/* ══════════════════════════════════════════
   REPORT VIEW  (btn-report in HTML)
══════════════════════════════════════════ */
function renderReport() {
  const mc = document.getElementById('main-content');
  let total = 0, ok = 0, low = 0, crit = 0;
  const alerts = [];

  const allowedDepts = getAllowedDepts();

  allowedDepts.forEach(dk => {
    getAllItems(dk).forEach(({ item, si, ii }) => {
      const key = `${si}_${ii}`;
      if ((weeklyStock[dk] || {})[key] === undefined) return;
      total++;
      const st = getStatus(getRunningStock(dk, key), item.par);
      if (st.cls === 's-ok')       ok++;
      else if (st.cls === 's-low') { low++;  alerts.push({ dept: DEPTS[dk].label, item: item.name, qty: getRunningStock(dk, key), par: item.par, unit: item.unit, level: 'low'      }); }
      else                         { crit++; alerts.push({ dept: DEPTS[dk].label, item: item.name, qty: getRunningStock(dk, key), par: item.par, unit: item.unit, level: 'critical'  }); }
    });
  });

  let html = `
    <div class="section-header">
      <div>
        <h2>📊 Daily Summary &amp; Alerts</h2>
        <p>${today.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}</p>
      </div>
      <button class="print-btn" onclick="window.print()">🖨 Print Report</button>
    </div>
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Items tracked</div><div class="metric-value">${total}</div></div>
      <div class="metric-card"><div class="metric-label">OK</div><div class="metric-value mv-ok">${ok}</div></div>
      <div class="metric-card"><div class="metric-label">Low stock</div><div class="metric-value mv-warn">${low}</div></div>
      <div class="metric-card"><div class="metric-label">Critical</div><div class="metric-value mv-danger">${crit}</div></div>
    </div>`;

  if (alerts.length === 0) {
    html += `<div class="all-clear"><div class="all-clear-icon">✅</div>
      <p>All stocked items are within acceptable levels.</p></div>`;
  } else {
    const crits = alerts.filter(a => a.level === 'critical');
    const lows  = alerts.filter(a => a.level === 'low');
    if (crits.length) {
      html += `<div class="alert-section"><div class="alert-title">🔴 Critical — reorder immediately</div>`;
      crits.forEach(a => {
        html += `<div class="alert-item critical">
          <div class="alert-icon">🚨</div>
          <div class="alert-item-text">
            <div class="alert-item-name">${a.dept} › ${a.item}</div>
            <div class="alert-item-detail">Remaining: ${a.qty} ${a.unit} &nbsp;|&nbsp; Par: ${a.par} ${a.unit}</div>
          </div></div>`;
      });
      html += `</div>`;
    }
    if (lows.length) {
      html += `<div class="alert-section"><div class="alert-title">🟡 Low stock — reorder soon</div>`;
      lows.forEach(a => {
        html += `<div class="alert-item low">
          <div class="alert-icon">⚠️</div>
          <div class="alert-item-text">
            <div class="alert-item-name">${a.dept} › ${a.item}</div>
            <div class="alert-item-detail">Remaining: ${a.qty} ${a.unit} &nbsp;|&nbsp; Par: ${a.par} ${a.unit}</div>
          </div></div>`;
      });
      html += `</div>`;
    }
  }

  // Running stock table
  html += `<div class="inv-card" style="margin-bottom:1.25rem;">
    <div class="inv-card-head">📋 Running Stock by Department</div>`;
  allowedDepts.forEach(dk => {
    const d = DEPTS[dk];
    html += `<div style="padding:12px 20px;border-bottom:1px solid var(--border);
      font-size:13px;font-weight:600;color:var(--text-secondary);">${d.icon} ${d.label}</div>
      <table class="log-table">
        <thead><tr><th>Item</th><th>Weekly Base</th><th>Arrived</th><th>${d.eodTerm || 'Sold'}</th><th>Remaining</th><th>Status</th></tr></thead>
        <tbody>`;
    getAllItems(dk).forEach(({ item, si, ii }) => {
      const key = `${si}_${ii}`;
      const w   = (weeklyStock[dk] || {})[key];
      if (w === undefined) return;
      const a   = parseFloat((arrivedStock[dk] || {})[key]) || 0;
      const s   = parseFloat((soldStock[dk]    || {})[key]) || 0;
      const rem = parseFloat(w) + a - s;
      const st  = getStatus(rem, item.par);
      html += `<tr>
        <td>${item.name} <span style="font-size:11px;color:var(--text-muted);">${item.unit}</span></td>
        <td style="font-family:'DM Mono',monospace;font-size:13px;">${w}</td>
        <td style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent);">+${a}</td>
        <td style="font-family:'DM Mono',monospace;font-size:13px;color:var(--danger);">-${s}</td>
        <td style="font-family:'DM Mono',monospace;font-size:13px;font-weight:600;">${rem}</td>
        <td><span class="status-pill ${st.cls}">${st.label}</span></td></tr>`;
    });
    html += `</tbody></table>`;
  });
  html += `</div>`;

  // EOD submission log
  html += `<div class="inv-card">
    <div class="inv-card-head">🌙 End-of-Day Submission Log</div>
    <table class="log-table">
      <thead><tr><th>Department</th><th>Submitted by</th><th>Time</th><th>Status</th></tr></thead>
      <tbody>`;
  allowedDepts.forEach(dk => {
    const d     = DEPTS[dk];
    const done  = !!eodSubmitted[dk];
    const entry = eodLog.find(l => l.dept === d.label);
    html += `<tr>
      <td>${d.icon} ${d.label}</td>
      <td>${entry ? entry.submitter : '—'}</td>
      <td style="font-family:'DM Mono',monospace;font-size:13px;">${entry ? entry.time : '—'}</td>
      <td><span class="status-pill ${done ? 's-ok' : 's-empty'}">${done ? 'DONE' : 'PENDING'}</span></td></tr>`;
  });
  html += `</tbody></table></div>`;
  mc.innerHTML = html;
}

/* ══════════════════════════════════════════
   DASHBOARD — admin-only weekly overview
   Sales/consumption + deliveries over the last 7 days,
   plus a live "needs purchasing" panel built from today's
   running stock vs par levels.
══════════════════════════════════════════ */
let dashCharts = {}; // holds Chart.js instances so we can destroy/redraw on refresh

function getDateKeysForLastNDays(n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(formatLocalDateKey(d));
  }
  return keys;
}

function chartColorForDept(dk) {
  const map = {
    housekeeping: '#2D7A50',
    bar:          '#B45309',
    kitchen:      '#1E3A5F',
    pizzeria:     '#991B1B',
  };
  return map[dk] || '#6B6861';
}

function renderDashboard() {
  const mc = document.getElementById('main-content');
  if (getUserDept() !== 'all') {
    mc.innerHTML = `<div class="success-card" style="display:block;max-width:500px;margin:2rem auto;">
      <div class="success-icon">🔒</div>
      <h3>Admin access only</h3>
      <p>The dashboard is available to admin/manager accounts.</p>
    </div>`;
    return;
  }

  mc.innerHTML = `
    <div class="section-header">
      <div>
        <h2>📈 Admin Dashboard</h2>
        <p>Weekly sales &amp; delivery trends, and items that need purchasing.</p>
      </div>
      <button class="print-btn" onclick="renderDashboard()">🔄 Refresh</button>
    </div>
    <div id="dash-stats" class="dash-grid">
      <div class="dash-loading"><div class="dash-spinner"></div>Loading this week's data…</div>
    </div>
    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-card-head">
          <div><h3>🛒 Sales / Consumption — Last 7 Days</h3><p>Units sold or used per day, by department</p></div>
        </div>
        <div class="chart-card-body"><canvas id="chart-sold"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-head">
          <div><h3>🚚 Deliveries Received — Last 7 Days</h3><p>Units arrived per day, by department</p></div>
        </div>
        <div class="chart-card-body"><canvas id="chart-arrived"></canvas></div>
      </div>
    </div>
    <div class="chart-card" style="margin-bottom:1.25rem;">
      <div class="chart-card-head">
        <div><h3>📦 Top Items Needing Purchase</h3><p>Ranked by quantity short of par level, right now</p></div>
      </div>
      <div class="chart-card-body tall"><canvas id="chart-purchase"></canvas></div>
      <div class="chart-legend-note">Needed qty = Par − Remaining, for any item currently LOW or CRITICAL.</div>
    </div>
    <div class="inv-card" id="purchase-table-card">
      <div class="inv-card-head">🧾 Purchase List Detail</div>
      <div class="purchase-table-wrap"><div class="dash-loading"><div class="dash-spinner"></div>Building purchase list…</div></div>
    </div>`;

  renderPurchaseList();       // synchronous — uses live in-memory state, no fetch needed
  loadDashboardWeeklyData();  // async — pulls last 7 days from Firestore
}

/* Items currently low/critical, across all departments, computed from
   the same running-stock logic used everywhere else in the app. */
function getPurchaseNeeds(deptsToUse) {
  const needs = [];
  (deptsToUse || getAllowedDepts()).forEach(dk => {
    getAllItems(dk).forEach(({ item, si, ii }) => {
      const key = `${si}_${ii}`;
      if ((weeklyStock[dk] || {})[key] === undefined) return; // never counted this week
      const remaining = getRunningStock(dk, key);
      const st = getStatus(remaining, item.par);
      if (st.cls === 's-low' || st.cls === 's-critical') {
        needs.push({
          dept: DEPTS[dk].label, deptIcon: DEPTS[dk].icon,
          item: item.name, unit: item.unit,
          remaining, par: item.par,
          needed: Math.max(0, item.par - remaining),
          level: st.cls === 's-critical' ? 'critical' : 'low'
        });
      }
    });
  });
  needs.sort((a, b) => b.needed - a.needed);
  return needs;
}

function renderPurchaseList() {
  const needs = getPurchaseNeeds();
  const wrap = document.querySelector('#purchase-table-card .purchase-table-wrap');
  if (!wrap) return;

  if (!needs.length) {
    wrap.innerHTML = `<div class="purchase-empty">✅ Nothing to purchase — every tracked item is above the low-stock threshold.</div>`;
  } else {
    wrap.innerHTML = `<table class="log-table">
      <thead><tr><th>Department</th><th>Item</th><th>Remaining</th><th>Par</th><th>Needed</th><th>Urgency</th></tr></thead>
      <tbody>
        ${needs.map(n => `<tr>
          <td>${n.deptIcon} ${n.dept}</td>
          <td>${n.item}</td>
          <td style="font-family:'DM Mono',monospace;">${n.remaining} ${n.unit}</td>
          <td style="font-family:'DM Mono',monospace;">${n.par} ${n.unit}</td>
          <td style="font-family:'DM Mono',monospace;font-weight:600;">${n.needed} ${n.unit}</td>
          <td><span class="needed-pill ${n.level}">${n.level === 'critical' ? 'CRITICAL' : 'LOW'}</span></td>
        </tr>`).join('')}
      </tbody></table>`;
  }

  // Top-15 horizontal bar chart of quantity needed
  const top = needs.slice(0, 15);
  const ctx = document.getElementById('chart-purchase');
  if (ctx && window.Chart) {
    if (dashCharts.purchase) dashCharts.purchase.destroy();
    dashCharts.purchase = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: top.map(n => `${n.item} (${n.dept})`),
        datasets: [{
          label: 'Qty needed',
          data: top.map(n => n.needed),
          backgroundColor: top.map(n => n.level === 'critical' ? '#991B1B' : '#92400E'),
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  }
}

function loadDashboardWeeklyData() {
  const dateKeys = getDateKeysForLastNDays(7);
  Promise.all(dateKeys.map(k => inventoryCol.doc(k).get()))
    .then(snaps => {
      const days = snaps.map((snap, i) => ({ date: dateKeys[i], data: snap.exists ? snap.data() : null }));
      renderDashboardCharts(days);
    })
    .catch(err => {
      const el = document.getElementById('dash-stats');
      if (el) el.innerHTML = `<div class="dash-loading">❌ Failed to load weekly data: ${err.message}</div>`;
    });
}

function renderDashboardCharts(days) {
  const dayLabels = days.map(d => new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));

  // Sum quantities per department per day, for sold and arrived
  const soldByDept    = {}; // dept -> [7 values]
  const arrivedByDept = {};
  deptKeys.forEach(dk => { soldByDept[dk] = days.map(() => 0); arrivedByDept[dk] = days.map(() => 0); });

  let weekSoldTotal = 0, weekArrivedTotal = 0;

  days.forEach((day, di) => {
    if (!day.data) return;
    const sold    = day.data.soldStock    || {};
    const arrived = day.data.arrivedStock || {};
    deptKeys.forEach(dk => {
      Object.values(sold[dk]    || {}).forEach(v => { const n = parseFloat(v) || 0; soldByDept[dk][di]    += n; weekSoldTotal    += n; });
      Object.values(arrived[dk] || {}).forEach(v => { const n = parseFloat(v) || 0; arrivedByDept[dk][di] += n; weekArrivedTotal += n; });
    });
  });

  const needs = getPurchaseNeeds();
  const critCount = needs.filter(n => n.level === 'critical').length;
  const lowCount  = needs.filter(n => n.level === 'low').length;

  // Stat cards
  const statsEl = document.getElementById('dash-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="dash-stat"><div class="dash-stat-icon i-accent">🛒</div>
        <div><div class="dash-stat-label">Sold/used this week</div><div class="dash-stat-value">${weekSoldTotal.toFixed(0)}</div></div></div>
      <div class="dash-stat"><div class="dash-stat-icon i-info">🚚</div>
        <div><div class="dash-stat-label">Delivered this week</div><div class="dash-stat-value">${weekArrivedTotal.toFixed(0)}</div></div></div>
      <div class="dash-stat"><div class="dash-stat-icon i-warn">🟡</div>
        <div><div class="dash-stat-label">Low stock items</div><div class="dash-stat-value">${lowCount}</div></div></div>
      <div class="dash-stat"><div class="dash-stat-icon i-danger">🔴</div>
        <div><div class="dash-stat-label">Critical items</div><div class="dash-stat-value">${critCount}</div></div></div>`;
  }

  if (!window.Chart) return; // Chart.js failed to load (e.g. offline) — stats still shown above

  const deptDatasets = (byDept) => deptKeys.map(dk => ({
    label: DEPTS[dk].icon + ' ' + DEPTS[dk].label,
    data: byDept[dk],
    backgroundColor: chartColorForDept(dk),
    borderRadius: 3,
  }));

  const soldCtx = document.getElementById('chart-sold');
  if (soldCtx) {
    if (dashCharts.sold) dashCharts.sold.destroy();
    dashCharts.sold = new Chart(soldCtx, {
      type: 'bar',
      data: { labels: dayLabels, datasets: deptDatasets(soldByDept) },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  }

  const arrivedCtx = document.getElementById('chart-arrived');
  if (arrivedCtx) {
    if (dashCharts.arrived) dashCharts.arrived.destroy();
    dashCharts.arrived = new Chart(arrivedCtx, {
      type: 'bar',
      data: { labels: dayLabels, datasets: deptDatasets(arrivedByDept) },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  }
}

/* ══════════════════════════════════════════
   PURCHASE ORDER REPORT — printable
   Section 1: suggested reorder list (low/critical items)
   Section 2: daily stock table per department —
              Item | Add Stock | Out Stock | Total Stock
══════════════════════════════════════════ */
function renderPurchaseOrderReport() {
  const mc = document.getElementById('main-content');
  const allowedDepts = getAllowedDepts();
  const needs = getPurchaseNeeds(allowedDepts);

  let html = `
    <div class="section-header">
      <div>
        <h2>🧾 Purchase Order Report</h2>
        <p>${today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
      </div>
      <button class="print-btn" onclick="window.print()">🖨 Print / Save as PDF</button>
    </div>`;

  // ── Section 1: Suggested Purchase Order ──
  html += `<div class="inv-card" style="margin-bottom:1.25rem;">
    <div class="inv-card-head">📋 Suggested Purchase Order — Items Below Par</div>`;
  if (!needs.length) {
    html += `<div class="purchase-empty" style="padding:1.5rem;">✅ Nothing to order — all tracked items are above the low-stock threshold.</div>`;
  } else {
    html += `<div class="purchase-table-wrap"><table class="log-table">
      <thead><tr><th>Department</th><th>Item</th><th>Remaining</th><th>Par</th><th>Qty to Order</th><th>Urgency</th></tr></thead>
      <tbody>
        ${needs.map(n => `<tr>
          <td>${n.deptIcon} ${n.dept}</td>
          <td>${n.item}</td>
          <td style="font-family:'DM Mono',monospace;">${n.remaining} ${n.unit}</td>
          <td style="font-family:'DM Mono',monospace;">${n.par} ${n.unit}</td>
          <td style="font-family:'DM Mono',monospace;font-weight:600;">${n.needed} ${n.unit}</td>
          <td><span class="needed-pill ${n.level}">${n.level === 'critical' ? 'CRITICAL' : 'LOW'}</span></td>
        </tr>`).join('')}
      </tbody></table></div>`;
  }
  html += `</div>`;

  // ── Section 2: Daily Stock Report — 4 columns per department ──
  allowedDepts.forEach(dk => {
    const d = DEPTS[dk];
    const outTerm = d.eodTerm || 'Sold';
    const rows = [];
    getAllItems(dk).forEach(({ item, si, ii }) => {
      const key = `${si}_${ii}`;
      const w = (weeklyStock[dk] || {})[key];
      if (w === undefined) return; // not counted this week yet
      const addQty = parseFloat((arrivedStock[dk] || {})[key]) || 0;
      const outQty = parseFloat((soldStock[dk]    || {})[key]) || 0;
      const total  = parseFloat(w) + addQty - outQty;
      const st     = getStatus(total, item.par);
      rows.push({ item, addQty, outQty, total, st });
    });

    html += `<div class="inv-card" style="margin-bottom:1.25rem;">
      <div class="inv-card-head">${d.icon} ${d.label} — Daily Stock Report</div>`;
    if (!rows.length) {
      html += `<div class="purchase-empty" style="padding:1.5rem;">No stock counted for ${d.label} yet this week.</div>`;
    } else {
      html += `<table class="log-table">
        <thead><tr><th>Item</th><th>Add Stock</th><th>${outTerm} Stock</th><th>Total Stock</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td>${r.item.name} <span style="font-size:11px;color:var(--text-muted);">${r.item.unit}</span></td>
            <td style="font-family:'DM Mono',monospace;color:var(--accent);">+${r.addQty}</td>
            <td style="font-family:'DM Mono',monospace;color:var(--danger);">-${r.outQty}</td>
            <td style="font-family:'DM Mono',monospace;font-weight:600;">
              ${r.total} <span class="status-pill ${r.st.cls}" style="margin-left:6px;">${r.st.label}</span>
            </td>
          </tr>`).join('')}
        </tbody></table>`;
    }
    html += `</div>`;
  });

  mc.innerHTML = html;
}

/* ══════════════════════════════════════════
   ADMIN CREDENTIALS
   dept: 'all'           → sees all departments (admin/manager)
   dept: 'housekeeping'  → sees only Housekeeping
   dept: 'bar'           → sees only Bar
   dept: 'kitchen'       → sees only Kitchen
   dept: 'pizzeria'      → sees only Pizzeria
══════════════════════════════════════════ */
const ADMIN_USERS = [
  { username: 'admin',        password: 'resort2024',  dept: 'all'          },
  { username: 'manager',      password: 'manager123',  dept: 'all'          },
  { username: 'housekeeping', password: 'hk2024',      dept: 'housekeeping' },
  { username: 'bar',          password: 'bar2024',     dept: 'bar'          },
  { username: 'kitchen',      password: 'kitchen2024', dept: 'kitchen'      },
  { username: 'pizzeria',     password: 'pizza2024',   dept: 'pizzeria'     },
  // Add more users — copy a line and change the values:
  // { username: 'yourname', password: 'yourpassword', dept: 'bar' },
];

/* ── LOGIN SYSTEM ── */
const SESSION_KEY = 'resort-auth';

function isLoggedIn() {
  return sessionStorage.getItem(SESSION_KEY) === 'true';
}

function attemptLogin() {
  const userEl = document.getElementById('login-username');
  const passEl = document.getElementById('login-password');
  const errEl  = document.getElementById('login-error');
  const btnEl  = document.getElementById('login-btn');

  const username = userEl ? userEl.value.trim() : '';
  const password = passEl ? passEl.value : '';

  if (!username || !password) {
    showLoginError('Please enter both username and password.');
    return;
  }

  // Shake the button while "checking"
  if (btnEl) btnEl.disabled = true;

  const matched = ADMIN_USERS.find(
    u => u.username === username && u.password === password
  );

  setTimeout(() => {
    if (matched) {
      sessionStorage.setItem(SESSION_KEY, 'true');
      sessionStorage.setItem(SESSION_KEY + '-user', matched.username);
      sessionStorage.setItem(SESSION_KEY + '-dept', matched.dept || 'all');
      hideLoginScreen();
      bootApp();
    } else {
      showLoginError('Incorrect username or password.');
      if (passEl) passEl.value = '';
      if (btnEl) btnEl.disabled = false;
      // Shake the card
      const card = document.getElementById('login-card');
      if (card) {
        card.classList.add('shake');
        setTimeout(() => card.classList.remove('shake'), 500);
      }
    }
  }, 400); // slight delay feels more secure
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY + '-user');
  location.reload();
}

function showLoginScreen() {
  // Hide the main app layout
  const layout  = document.querySelector('.layout');
  const topbar  = document.querySelector('.topbar');
  if (layout) layout.style.display  = 'none';
  if (topbar) topbar.style.display  = 'none';

  // Build login overlay
  const overlay = document.createElement('div');
  overlay.id = 'login-overlay';
  overlay.innerHTML = `
    <div id="login-card">
      <div id="login-logo">🏨</div>
      <div id="login-title">Resort Inventory</div>
      <div id="login-subtitle">Sign in to continue</div>

      <div class="login-field">
        <label class="login-label">Username</label>
        <input class="login-input" type="text" id="login-username"
          placeholder="Enter username" autocomplete="username"
          onkeydown="if(event.key==='Enter')document.getElementById('login-password').focus()">
      </div>

      <div class="login-field">
        <label class="login-label">Password</label>
        <div class="login-pw-wrap">
          <input class="login-input" type="password" id="login-password"
            placeholder="Enter password" autocomplete="current-password"
            onkeydown="if(event.key==='Enter')attemptLogin()">
          <button class="login-pw-toggle" onclick="toggleLoginPw()" title="Show/hide password">👁</button>
        </div>
      </div>

      <div id="login-error"></div>

      <button id="login-btn" onclick="attemptLogin()">Sign In</button>

      <div id="login-footer">Resort Daily Inventory System</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Inject login styles
  const style = document.createElement('style');
  style.id = 'login-styles';
  style.textContent = `
    #login-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: var(--bg, #f0f4f8);
      display: flex; align-items: center; justify-content: center;
      font-family: inherit;
    }
    #login-card {
      background: var(--surface, #fff);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 20px;
      padding: 40px 36px 32px;
      width: 100%; max-width: 380px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.10);
      display: flex; flex-direction: column; gap: 0;
    }
    #login-logo {
      font-size: 48px; text-align: center; margin-bottom: 8px;
    }
    #login-title {
      font-size: 22px; font-weight: 800; text-align: center;
      color: var(--text-primary, #1a202c); margin-bottom: 4px;
    }
    #login-subtitle {
      font-size: 13px; text-align: center;
      color: var(--text-muted, #94a3b8); margin-bottom: 28px;
    }
    .login-field {
      display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px;
    }
    .login-label {
      font-size: 12px; font-weight: 600; letter-spacing: .05em;
      color: var(--text-secondary, #64748b); text-transform: uppercase;
    }
    .login-input {
      width: 100%; padding: 10px 14px; border-radius: 10px;
      border: 1.5px solid var(--border, #e2e8f0);
      background: var(--bg, #f8fafc);
      color: var(--text-primary, #1a202c);
      font-size: 14px; outline: none; box-sizing: border-box;
      transition: border-color .2s;
    }
    .login-input:focus { border-color: var(--accent, #6366f1); }
    .login-pw-wrap { position: relative; display: flex; align-items: center; }
    .login-pw-wrap .login-input { padding-right: 40px; }
    .login-pw-toggle {
      position: absolute; right: 10px;
      background: none; border: none; cursor: pointer;
      font-size: 16px; color: var(--text-muted, #94a3b8);
      padding: 0; line-height: 1;
    }
    #login-error {
      display: none; color: #ef4444;
      font-size: 13px; text-align: center;
      background: #fef2f2; border: 1px solid #fecaca;
      border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;
    }
    #login-btn {
      width: 100%; padding: 12px;
      background: var(--accent, #6366f1); color: #fff;
      border: none; border-radius: 10px; font-size: 15px;
      font-weight: 700; cursor: pointer; margin-top: 4px;
      transition: opacity .2s, transform .1s;
    }
    #login-btn:hover:not(:disabled) { opacity: .9; }
    #login-btn:active { transform: scale(.98); }
    #login-btn:disabled { opacity: .6; cursor: not-allowed; }
    #login-footer {
      margin-top: 24px; text-align: center;
      font-size: 11px; color: var(--text-muted, #94a3b8);
    }
    @keyframes shake {
      0%,100%{transform:translateX(0)}
      20%{transform:translateX(-8px)}
      40%{transform:translateX(8px)}
      60%{transform:translateX(-6px)}
      80%{transform:translateX(6px)}
    }
    #login-card.shake { animation: shake .45s ease; }
  `;
  document.head.appendChild(style);

  // Focus username field
  setTimeout(() => {
    const el = document.getElementById('login-username');
    if (el) el.focus();
  }, 50);
}

function toggleLoginPw() {
  const el = document.getElementById('login-password');
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

function hideLoginScreen() {
  const overlay = document.getElementById('login-overlay');
  const styles  = document.getElementById('login-styles');
  if (overlay) overlay.remove();
  if (styles)  styles.remove();

  // Restore app layout
  const layout = document.querySelector('.layout');
  const topbar = document.querySelector('.topbar');
  if (layout) layout.style.display = '';
  if (topbar) topbar.style.display = '';
}

/* ── MANUAL RECOVERY TOOL ──
   For when a day got skipped and custom sections/items entered on an
   earlier date never got carried forward automatically. Run from the
   browser console:
     recoverCustomItemsFromDate("2026-07-07")
   Only restores section names and item definitions (name/unit/par) —
   it deliberately does NOT touch stock quantities, so it's safe to run
   without messing up today's counts. */
function recoverCustomItemsFromDate(dateStr) {
  if (!dateStr) {
    alert('Usage: recoverCustomItemsFromDate("YYYY-MM-DD") — e.g. recoverCustomItemsFromDate("2026-07-07")');
    return;
  }
  inventoryCol.doc(dateStr).get().then(snap => {
    if (!snap.exists) { alert('No saved data found for ' + dateStr + '.'); return; }
    const d = snap.data();
    let recovered = 0;
    const recoveredNames = [];

    Object.keys(DEPTS).forEach(dept => {
      // Recover custom sections
      const prevSections = (d.customSections || {})[dept] || [];
      if (prevSections.length) {
        if (!customSections[dept]) customSections[dept] = [];
        prevSections.forEach(name => {
          if (!customSections[dept].includes(name)) {
            customSections[dept].push(name);
            recovered++;
            recoveredNames.push(`Section "${name}" (${DEPTS[dept].label})`);
          }
        });
      }
      // Recover custom items
      const prevItems = (d.customItems || {})[dept] || [];
      if (prevItems.length) {
        if (!customItems[dept]) customItems[dept] = [];
        prevItems.forEach(item => {
          const exists = customItems[dept].some(c => normalizeItemName(c.name) === normalizeItemName(item.name));
          if (!exists) {
            customItems[dept].push(item);
            recovered++;
            recoveredNames.push(`Item "${item.name}" (${DEPTS[dept].label})`);
          }
        });
      }
    });

    if (recovered === 0) {
      alert('Nothing new to recover from ' + dateStr + ' — those sections/items already appear to be present today.');
      return;
    }
    saveToFirebase();
    renderCurrentView();
    alert('Recovered ' + recovered + ' item(s)/section(s) from ' + dateStr + ':\n\n' + recoveredNames.join('\n') + '\n\nSaved to today.');
  }).catch(err => alert('Error loading ' + dateStr + ': ' + err.message));
}
/* Same as recoverCustomItemsFromDate, but scans the last N days automatically —
   no need to know/type the exact date. Run from the browser console:
     recoverAllRecentCustomItems()
   Safe to run anytime: only adds missing sections/items, never touches
   stock quantities, and skips anything that already exists today. */
function recoverAllRecentCustomItems(daysBack = 14) {
  const dateKeys = [];
  for (let i = 1; i <= daysBack; i++) dateKeys.push(getDateKeyOffset(i));

  Promise.all(dateKeys.map(k => inventoryCol.doc(k).get()))
    .then(snaps => {
      let recovered = 0;
      const recoveredNames = [];
      const checkedDates = [];
      const foundDates = [];

      snaps.forEach((snap, i) => {
        const dateStr = dateKeys[i];
        checkedDates.push(dateStr);
        if (!snap.exists) return;
        foundDates.push(dateStr);
        const d = snap.data();

        Object.keys(DEPTS).forEach(dept => {
          const prevSections = (d.customSections || {})[dept] || [];
          prevSections.forEach(name => {
            if (!customSections[dept]) customSections[dept] = [];
            if (!customSections[dept].includes(name)) {
              customSections[dept].push(name);
              recovered++;
              recoveredNames.push(`Section "${name}" (${DEPTS[dept].label}) — from ${dateStr}`);
            }
          });

          const prevItems = (d.customItems || {})[dept] || [];
          prevItems.forEach(item => {
            if (!customItems[dept]) customItems[dept] = [];
            const exists = customItems[dept].some(c => normalizeItemName(c.name) === normalizeItemName(item.name));
            if (!exists) {
              customItems[dept].push(item);
              recovered++;
              recoveredNames.push(`Item "${item.name}" (${DEPTS[dept].label}) — from ${dateStr}`);
            }
          });
        });
      });

      if (recovered === 0) {
        alert('Scanned ' + checkedDates.length + ' day(s) back (' + checkedDates[checkedDates.length - 1] + ' to ' + checkedDates[0] + ').\n'
          + 'Days with saved data found: ' + (foundDates.length ? foundDates.join(', ') : 'none') + '\n\n'
          + 'Nothing new to recover — either it\'s already present today, or the data lives further back than ' + daysBack + ' days '
          + '(try recoverAllRecentCustomItems(30) for a longer scan).');
        return;
      }
      saveToFirebase();
      renderCurrentView();
      Object.keys(DEPTS).forEach(dk => updateBadge(dk));
      alert('Recovered ' + recovered + ' item(s)/section(s):\n\n' + recoveredNames.join('\n') + '\n\nSaved to today.');
    })
    .catch(err => alert('Error scanning recent days: ' + err.message));
}
window.recoverAllRecentCustomItems = recoverAllRecentCustomItems;
window.recoverCustomItemsFromDate  = recoverCustomItemsFromDate;

/* ── ROLE HELPER ── */
function getUserDept() {
  return sessionStorage.getItem(SESSION_KEY + '-dept') || 'all';
}

/* Returns the list of dept keys this user can access */
function getAllowedDepts() {
  const role = getUserDept();
  return role === 'all' ? deptKeys : deptKeys.filter(dk => dk === role);
}

function bootApp() {
  const userDept = getUserDept();
  const allowed  = getAllowedDepts();

  // ── Lock topbar dept tabs: hide depts the user cannot access ──
  deptKeys.forEach(dk => {
    const tab = document.getElementById('tab-' + dk);
    if (!tab) return;
    if (allowed.includes(dk)) {
      tab.style.display = '';
    } else {
      tab.style.display = 'none';
    }
  });

  // ── Force currentDept to the user's allowed dept ──
  if (userDept !== 'all') {
    currentDept = userDept;
    // Mark the correct topbar dept tab active
    document.querySelectorAll('.dept-tab').forEach(b => b.classList.remove('active'));
    const activeTab = document.getElementById('tab-' + userDept);
    if (activeTab) activeTab.classList.add('active');
  }

  // ── Dashboard is admin/manager-only ──
  const dashBtn = document.getElementById('btn-dashboard');
  if (dashBtn) dashBtn.style.display = (userDept === 'all') ? '' : 'none';

  // ── Single-dept users don't need the department toggle (they only have one) ──
  if (userDept !== 'all') {
    const deptToggle = document.getElementById('dept-toggle');
    if (deptToggle) deptToggle.style.display = 'none';
  }

  // ── Date in top bar ──
  const dateEl = document.getElementById('top-date');
  if (dateEl) dateEl.textContent = today.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  // ── Inject sync badge ──
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight) {
    const badge = document.createElement('span');
    badge.id = 'sync-badge';
    badge.style.cssText = 'font-size:12px;color:var(--text-muted);transition:opacity 0.5s;opacity:0;white-space:nowrap;';
    topbarRight.insertBefore(badge, topbarRight.firstChild);
  }

  // ── Inject user info + logout in topbar ──
  const topbarBrand = document.querySelector('.topbar-brand');
  if (topbarBrand) {
    const currentUser = sessionStorage.getItem(SESSION_KEY + '-user') || 'User';
    const deptLabel   = userDept === 'all' ? 'All Departments' : (DEPTS[userDept] ? DEPTS[userDept].icon + ' ' + DEPTS[userDept].label : userDept);
    const logoutEl    = document.createElement('div');
    logoutEl.style.cssText = 'font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:8px;margin-left:12px;';
    logoutEl.innerHTML = `
      <span>👤 <strong>${currentUser}</strong> &nbsp;·&nbsp; ${deptLabel}</span>
      <button onclick="logout()" style="
        background:none;border:1px solid var(--border);border-radius:6px;
        padding:3px 10px;font-size:11px;cursor:pointer;
        color:var(--text-muted);font-weight:600;">Logout</button>
    `;
    topbarBrand.appendChild(logoutEl);
  }

  // ── Load Firebase → render → subscribe ──
  loadFromFirebase(() => {
    renderCurrentView();
    allowed.forEach(dk => updateBadge(dk));
    subscribeRealtime();
  });
}

/* ── EXPOSE GLOBALS ── */
window.toggleTheme      = toggleTheme;
window.setView          = setView;
window.setDept          = setDept;
window.setStep          = setStep;
window.nextDept         = nextDept;
window.weeklyStock      = weeklyStock;
window.arrivedStock     = arrivedStock;
window.soldStock        = soldStock;
window.customItems      = customItems;
window.customSections   = customSections;
window.weeklySubmitted  = weeklySubmitted;
window.eodSubmitted     = eodSubmitted;
window.getStatus        = getStatus;
window.submitWeekly     = submitWeekly;
window.submitArrived    = submitArrived;
window.submitEod        = submitEod;
window.addCustomItem    = addCustomItem;
window.addCustomSection = addCustomSection;
window.removeCustomSection = removeCustomSection;
window.checkExistingItemName = checkExistingItemName;
window.removeCustomItem = removeCustomItem;
window.resetAllCustomItems = resetAllCustomItems;
window.updateAddPreview = updateAddPreview;
window.updateEodRow     = updateEodRow;
window.renderWeeklyForm = renderWeeklyForm;
window.renderEodForm    = renderEodForm;
window.renderDashboard  = renderDashboard;
window.renderPurchaseOrderReport = renderPurchaseOrderReport;
window.saveToFirebase   = saveToFirebase;
window.loadFromFirebase = loadFromFirebase;
window.attemptLogin     = attemptLogin;
window.toggleLoginPw    = toggleLoginPw;
window.logout           = logout;

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', () => {
  if (isLoggedIn()) {
    // Already signed in this session — go straight to app
    bootApp();
  } else {
    // Show login screen first
    showLoginScreen();
  }
});