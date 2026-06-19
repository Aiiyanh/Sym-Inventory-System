/* ═══════════════════════════════════════════════════════
   FIREBASE — compat mode (scripts loaded in HTML already)
═══════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey:            "AIzaSyD3P6WdxzPm2jDBkSeJ0DzywufAvypcmjo",
  authDomain:        "sym-inventory.firebaseapp.com",
  databaseURL:       "https://sym-inventory-default-rtdb.firebaseio.com",
  projectId:         "sym-inventory",
  storageBucket:     "sym-inventory.firebasestorage.app",
  messagingSenderId: "984361187387",
  appId:             "1:984361187387:web:dc2a56adcb1bef217e441e",
  measurementId:     "G-4GE9LWNNK4"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* ── FIREBASE HELPERS ── */
function getDateKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function getYesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function saveToFirebase() {
  const payload = {
    weeklyStock, arrivedStock, soldStock,
    arrivedLog, eodLog, customItems,
    weeklySubmitted, eodSubmitted,
    lastSaved: new Date().toISOString()
  };
  db.ref('inventory/' + getDateKey()).set(payload)
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

  Object.keys(DEPTS).forEach(dept => {
    if (!weeklyStock[dept]) weeklyStock[dept] = {};

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
      if (key.startsWith('__')) return;
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
  db.ref('inventory/' + getDateKey()).once('value').then(snap => {
    const todayData = snap.val();
    if (todayData) {
      // Today already has data — just load it normally
      mergeState(todayData);
      showSyncBadge('✅ Data loaded');
      if (callback) callback();
    } else {
      // No data for today — check yesterday for carry-over
      db.ref('inventory/' + getYesterdayKey()).once('value').then(ySnap => {
        const yesterdayData = ySnap.val();
        if (yesterdayData) {
          applyCarryOver(yesterdayData);
          // Save the carried-over opening balance as today's starting point
          saveToFirebase();
        } else {
          showSyncBadge('ℹ️ No previous data found — starting fresh');
        }
        if (callback) callback();
      });
    }
  }).catch(err => {
    showSyncBadge('❌ Load failed: ' + err.message);
    if (callback) callback();
  });
}

function subscribeRealtime() {
  db.ref('inventory/' + getDateKey()).on('value', snap => {
    const d = snap.val();
    if (!d) return;
    mergeState(d);
    renderCurrentView();
    Object.keys(DEPTS).forEach(dk => updateBadge(dk));
    showSyncBadge('🔄 Synced');
  });
}

function mergeState(d) {
  Object.assign(weeklyStock,     d.weeklyStock     || {});
  Object.assign(arrivedStock,    d.arrivedStock    || {});
  Object.assign(soldStock,       d.soldStock       || {});
  Object.assign(customItems,     d.customItems     || {});
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

/* ── DEPARTMENT DATA ── */
const DEPTS = {
  housekeeping: {
    label: 'Housekeeping', icon: '🧹',
    sections: [
      { name: 'Linens', items: [
        { name: 'Bed sheets',        unit: 'sets',    par: 50  },
        { name: 'Pillowcases',       unit: 'pcs',     par: 100 },
        { name: 'Bath towels',       unit: 'pcs',     par: 80  },
        { name: 'Hand towels',       unit: 'pcs',     par: 60  },
        { name: 'Bathrobes',         unit: 'pcs',     par: 30  },
      ]},
      { name: 'Amenities', items: [
        { name: 'Shampoo bottles',   unit: 'pcs',     par: 60  },
        { name: 'Soap bars',         unit: 'pcs',     par: 60  },
        { name: 'Conditioner',       unit: 'pcs',     par: 40  },
        { name: 'Toothbrush kits',   unit: 'pcs',     par: 30  },
        { name: 'Tissue boxes',      unit: 'boxes',   par: 40  },
        { name: 'Toilet paper rolls',unit: 'rolls',   par: 100 },
      ]},
      { name: 'Cleaning Supplies', items: [
        { name: 'Detergent',         unit: 'liters',  par: 10  },
        { name: 'Disinfectant spray',unit: 'bottles', par: 15  },
        { name: 'Trash bags',        unit: 'packs',   par: 10  },
        { name: 'Gloves',            unit: 'pairs',   par: 20  },
      ]},
    ]
  },
  bar: {
    label: 'Bar', icon: '🍹',
    sections: [
      { name: 'Spirits', items: [
        { name: 'Rum',      unit: 'bottles', par: 10 },
        { name: 'Vodka',    unit: 'bottles', par: 10 },
        { name: 'Gin',      unit: 'bottles', par: 8  },
        { name: 'Whiskey',  unit: 'bottles', par: 8  },
        { name: 'Tequila',  unit: 'bottles', par: 6  },
        { name: 'Brandy',   unit: 'bottles', par: 5  },
      ]},
      { name: 'Beer & Wine', items: [
        { name: 'Beer (cans)', unit: 'cans',    par: 60 },
        { name: 'Red wine',    unit: 'bottles', par: 12 },
        { name: 'White wine',  unit: 'bottles', par: 12 },
      ]},
      { name: 'Mixers & Garnish', items: [
        { name: 'Juice assorted', unit: 'liters',  par: 20 },
        { name: 'Soda water',     unit: 'bottles', par: 24 },
        { name: 'Simple syrup',   unit: 'bottles', par: 6  },
        { name: 'Lime / lemon',   unit: 'pcs',     par: 30 },
      ]},
      { name: 'Consumables', items: [
        { name: 'Cocktail straws',  unit: 'packs', par: 5  },
        { name: 'Cocktail napkins', unit: 'packs', par: 5  },
        { name: 'Ice',              unit: 'bags',  par: 10 },
      ]},
    ]
  },
  kitchen: {
    label: 'Kitchen', icon: '🍽️',
    sections: [
      { name: 'Protein (Perishable)', items: [
        { name: 'Chicken',       unit: 'kg',  par: 15  },
        { name: 'Pork',          unit: 'kg',  par: 10  },
        { name: 'Beef',          unit: 'kg',  par: 8   },
        { name: 'Fish / seafood',unit: 'kg',  par: 8   },
        { name: 'Eggs',          unit: 'pcs', par: 120 },
      ]},
      { name: 'Vegetables & Dairy', items: [
        { name: 'Onions',       unit: 'kg',     par: 5  },
        { name: 'Garlic',       unit: 'kg',     par: 2  },
        { name: 'Tomatoes',     unit: 'kg',     par: 5  },
        { name: 'Leafy greens', unit: 'kg',     par: 3  },
        { name: 'Milk',         unit: 'liters', par: 10 },
        { name: 'Butter',       unit: 'kg',     par: 3  },
        { name: 'Cream',        unit: 'liters', par: 4  },
      ]},
      { name: 'Dry Goods', items: [
        { name: 'Rice',        unit: 'kg',     par: 20 },
        { name: 'Pasta',       unit: 'kg',     par: 5  },
        { name: 'Flour',       unit: 'kg',     par: 10 },
        { name: 'Sugar',       unit: 'kg',     par: 5  },
        { name: 'Cooking oil', unit: 'liters', par: 8  },
        { name: 'Soy sauce',   unit: 'liters', par: 3  },
        { name: 'Salt',        unit: 'kg',     par: 3  },
      ]},
    ]
  },
  pizzeria: {
    label: 'Pizzeria', icon: '🍕',
    sections: [
      { name: 'Dough & Base', items: [
        { name: 'Pizza flour',  unit: 'kg',    par: 15 },
        { name: 'Yeast',        unit: 'packs', par: 10 },
        { name: 'Olive oil',    unit: 'liters',par: 3  },
        { name: 'Tomato sauce', unit: 'cans',  par: 12 },
      ]},
      { name: 'Cheese & Toppings', items: [
        { name: 'Mozzarella', unit: 'kg', par: 8 },
        { name: 'Pepperoni',  unit: 'kg', par: 4 },
        { name: 'Mushrooms',  unit: 'kg', par: 3 },
        { name: 'Bell peppers',unit:'kg', par: 2 },
        { name: 'Olives',     unit: 'kg', par: 2 },
        { name: 'Ham / bacon',unit: 'kg', par: 3 },
      ]},
      { name: 'Packaging', items: [
        { name: 'Pizza boxes 10"', unit: 'pcs',    par: 50  },
        { name: 'Pizza boxes 12"', unit: 'pcs',    par: 50  },
        { name: 'Parchment paper', unit: 'sheets', par: 100 },
        { name: 'Paper bags',      unit: 'pcs',    par: 40  },
      ]},
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
  ['form', 'report'].forEach(v => {
    const btn = document.getElementById('btn-' + v);
    if (btn) btn.classList.toggle('active', v === view);
  });
  renderCurrentView();
}

function setDept(dept) {
  currentDept = dept;
  document.querySelectorAll('.dept-btn').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById('tab-' + dept);
  if (tab) tab.classList.add('active');
  renderCurrentView();
}

function setStep(step) {
  currentStep = step;
  renderCurrentView();
}

function renderCurrentView() {
  if (currentView === 'report') { renderReport(); return; }
  // 'form' view — render sub-step
  if (currentStep === 'weekly')   renderWeeklyForm();
  else if (currentStep === 'addstock') renderAddStockForm();
  else renderEodForm();
}

function nextDept() {
  const cur = deptKeys.indexOf(currentDept);
  setDept(deptKeys[(cur + 1) % deptKeys.length]);
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
        <button class="next-btn" onclick="nextDept()">Next department →</button>
        <button class="next-btn" style="margin-top:8px;"
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
        <input class="name-input" type="text" placeholder="Your name"
          id="wname-${currentDept}" value="${saved['__name__'] || ''}">
      </div>
    </div>`;

  d.sections.forEach((sec, si) => {
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${sec.name}</div>
      <table class="inv-table">
        <thead><tr><th>Item</th><th>Stock on hand</th><th>Par</th><th>Status</th></tr></thead>
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
        </td></tr>`;
    });
    html += `</tbody></table></div>`;
  });

  // Custom items
  const customs = customItems[currentDept] || [];
  html += `<div class="inv-card">
    <div class="inv-card-head">➕ Custom / Added Items</div>
    <table class="inv-table">
      <thead><tr><th>Item</th><th>Stock on hand</th><th>Par</th><th>Status</th><th></th></tr></thead>
      <tbody id="custom-rows-${currentDept}">`;
  customs.forEach((item, ii) => {
    const key = `99_${ii}`;
    const val = saved[key] !== undefined ? saved[key] : '';
    const st  = getStatus(val, item.par);
    html += `<tr id="crow-${currentDept}-${ii}">
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
        <button onclick="removeCustomItem('${currentDept}',${ii})"
          style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:16px;">✕</button>
      </td></tr>`;
  });
  html += `</tbody></table>
    <div style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--border);">
      <input class="name-input" type="text" placeholder="Item name"
        id="new-item-name-${currentDept}" style="width:140px;">
      <input class="name-input" type="text" placeholder="Unit (e.g. pcs)"
        id="new-item-unit-${currentDept}" style="width:100px;">
      <input class="qty-input" type="number" min="0" placeholder="Par"
        id="new-item-par-${currentDept}" style="width:80px;">
      <button class="submit-btn" style="padding:6px 14px;font-size:13px;"
        onclick="addCustomItem('${currentDept}')">+ Add Item</button>
    </div></div>`;

  html += `<div class="notes-section">
    <div class="notes-label">📝 Notes / Remarks</div>
    <textarea class="notes-area" placeholder="Notes about this week's stock…"
      id="wnotes-${currentDept}">${saved['__notes__'] || ''}</textarea>
  </div>
  <div class="submit-row">
    <button class="submit-btn" onclick="submitWeekly('${currentDept}')">
      ✓ Save Weekly Stock for ${d.label}
    </button>
  </div>`;

  mc.innerHTML = html;
}

function addCustomItem(dept) {
  const name = (document.getElementById(`new-item-name-${dept}`) || {}).value?.trim();
  const unit = (document.getElementById(`new-item-unit-${dept}`) || {}).value?.trim() || 'pcs';
  const par  = parseFloat((document.getElementById(`new-item-par-${dept}`) || {}).value) || 1;
  if (!name) { alert('Please enter an item name.'); return; }
  if (!customItems[dept]) customItems[dept] = [];
  customItems[dept].push({ name, unit, par });
  renderWeeklyForm();
}

function removeCustomItem(dept, idx) {
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
  renderWeeklyForm();
}

function submitWeekly(dept) {
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
  const nameEl  = document.getElementById('wname-' + dept);
  const notesEl = document.getElementById('wnotes-' + dept);
  weeklyStock[dept]['__name__']  = nameEl  ? nameEl.value.trim() || 'Staff' : 'Staff';
  weeklyStock[dept]['__notes__'] = notesEl ? notesEl.value : '';
  weeklyStock[dept]['__time__']  = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  weeklySubmitted[dept] = true;
  updateBadge(dept);
  saveToFirebase();
  renderWeeklyForm();
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
        <input class="name-input" type="text" placeholder="Your name" id="aname-${currentDept}">
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

  const allSections = d.sections.map((sec, si) => ({ name: sec.name, items: sec.items, si }));
  const customs = customItems[currentDept] || [];
  if (customs.length) allSections.push({ name: 'Custom / Added Items', items: customs, si: 99 });

  allSections.forEach(({ name, items, si }) => {
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${name}</div>
      <table class="inv-table">
        <thead><tr><th>Item</th><th>Current stock</th><th>Add qty</th><th>New total</th></tr></thead>
        <tbody>`;
    items.forEach((item, ii) => {
      const key     = `${si}_${ii}`;
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
  const name = (document.getElementById('aname-' + dept) || {}).value?.trim() || 'Staff';
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
        <p>Sold quantities saved. Check the report for remaining stock.</p>
        <button class="next-btn" onclick="nextDept()">Next department →</button>
        <button class="next-btn" style="margin-top:8px;"
          onclick="eodSubmitted['${currentDept}']=false;renderEodForm()">✏️ Edit</button>
        <button class="next-btn" style="margin-top:8px;"
          onclick="setView('report')">📊 View Report</button>
      </div>`;
    return;
  }

  let html = stepTabsHtml() + `
    <div class="section-header">
      <div>
        <h2>${d.icon} ${d.label} — End-of-Day Sold Inventory</h2>
        <p>Enter quantities sold/consumed today. Remaining stock computed automatically.</p>
      </div>
      <div class="submitter-row">
        <input class="name-input" type="text" placeholder="Your name"
          id="ename-${currentDept}" value="${saved['__name__'] || ''}">
      </div>
    </div>`;

  const renderEodSection = (items, si) => {
    items.forEach((item, ii) => {
      const key       = `${si}_${ii}`;
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

  d.sections.forEach((sec, si) => {
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 ${sec.name}</div>
      <table class="inv-table">
        <thead><tr>
          <th>Item</th><th>Available</th><th>Qty sold</th><th>Remaining</th><th>Status</th>
        </tr></thead><tbody>`;
    renderEodSection(sec.items, si);
    html += `</tbody></table></div>`;
  });

  const customs = customItems[currentDept] || [];
  if (customs.length) {
    html += `<div class="inv-card">
      <div class="inv-card-head">📦 Custom / Added Items</div>
      <table class="inv-table">
        <thead><tr>
          <th>Item</th><th>Available</th><th>Qty sold</th><th>Remaining</th><th>Status</th>
        </tr></thead><tbody>`;
    renderEodSection(customs, 99);
    html += `</tbody></table></div>`;
  }

  html += `<div class="notes-section">
    <div class="notes-label">📝 End-of-Day Notes</div>
    <textarea class="notes-area" placeholder="Items that ran out, wastage, special remarks…"
      id="enotes-${currentDept}">${saved['__notes__'] || ''}</textarea>
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
  const name = (document.getElementById('ename-' + dept) || {}).value?.trim() || 'Staff';
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
  soldStock[dept]['__name__']  = name;
  soldStock[dept]['__notes__'] = notesEl ? notesEl.value : '';
  soldStock[dept]['__time__']  = time;
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

  deptKeys.forEach(dk => {
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
  deptKeys.forEach(dk => {
    const d = DEPTS[dk];
    html += `<div style="padding:12px 20px;border-bottom:1px solid var(--border);
      font-size:13px;font-weight:600;color:var(--text-secondary);">${d.icon} ${d.label}</div>
      <table class="log-table">
        <thead><tr><th>Item</th><th>Weekly Base</th><th>Arrived</th><th>Sold</th><th>Remaining</th><th>Status</th></tr></thead>
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
  deptKeys.forEach(dk => {
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

  // ── Lock sidebar: hide tabs the user cannot access ──
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
    // Mark the correct sidebar tab active
    document.querySelectorAll('.dept-btn').forEach(b => b.classList.remove('active'));
    const activeTab = document.getElementById('tab-' + userDept);
    if (activeTab) activeTab.classList.add('active');
  }

  // ── Hide the department sidebar entirely if single-dept user ──
  if (userDept !== 'all') {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.style.display = 'none';
    // Give main content full width
    const main = document.getElementById('main-content');
    if (main) main.style.gridColumn = '1 / -1';
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
window.weeklySubmitted  = weeklySubmitted;
window.eodSubmitted     = eodSubmitted;
window.getStatus        = getStatus;
window.submitWeekly     = submitWeekly;
window.submitArrived    = submitArrived;
window.submitEod        = submitEod;
window.addCustomItem    = addCustomItem;
window.removeCustomItem = removeCustomItem;
window.updateAddPreview = updateAddPreview;
window.updateEodRow     = updateEodRow;
window.renderWeeklyForm = renderWeeklyForm;
window.renderEodForm    = renderEodForm;
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