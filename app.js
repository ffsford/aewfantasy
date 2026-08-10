// =====================================================
// AEW Fantasy League – Season 9 (Supabase live version)
// =====================================================

const FO_TYPES = {
  wheel: { name: 'Wheel Of Boom', bankable: false },
  forced_trade: { name: 'Forced Trade', bankable: true },
  waiver_bank: { name: 'Waiver In The Bank', bankable: true },
  ppv_week: { name: 'PPV Week', bankable: true },
  waiver_disrupter: { name: 'Waiver Disrupter', bankable: true }
};

const WHEEL_SEGMENTS = [
  { label: '+20 Points', color: '#3b82f6', effect: 'points', value: 20 },
  { label: '+30 Points', color: '#8b5cf6', effect: 'points', value: 30 },
  { label: '+40 Points', color: '#ec4899', effect: 'points', value: 40 },
  { label: '+50 Points', color: '#ef4444', effect: 'points', value: 50 },
  { label: 'Roster → 9', color: '#10b981', effect: 'roster9', value: null },
  { label: 'Steal 5 pts\n(from all)', color: '#f59e0b', effect: 'steal5', value: null }
];

const SCORING = [
  { action: 'Lose a match / No Contest', tv: 1, ppv: 2, section: 'non-title' },
  { action: 'Draw / DQ Win', tv: 2, ppv: 4, section: 'non-title' },
  { action: 'Win a match', tv: 3, ppv: 6, section: 'non-title' },
  { action: 'Lose Non-AEW Title match (ROH, NJPW, etc)', tv: 3, ppv: 6, section: 'non-aew' },
  { action: 'Defend Non-AEW Title', tv: 4, ppv: 8, section: 'non-aew' },
  { action: 'Become new Non-AEW Champion', tv: 5, ppv: 10, section: 'non-aew' },
  { action: 'Lose TNT/TBS/International/Tags/Continental Title match', tv: 4, ppv: 8, section: 'mid' },
  { action: 'Defend TNT/TBS/International/Tags/Continental Title', tv: 5, ppv: 10, section: 'mid' },
  { action: 'Become new TNT/TBS/International/Tags/Continental Champion', tv: 6, ppv: 12, section: 'mid' },
  { action: 'Lose Men / Women\'s World Title match', tv: 7, ppv: 14, section: 'world' },
  { action: 'Defend Men / Women\'s World Title', tv: 8, ppv: 16, section: 'world' },
  { action: 'Become new Men / Women\'s World Champion', tv: 9, ppv: 18, section: 'world' }
];

let data = {
  users: {},
  points: {},
  masterRoster: [],
  claims: {},
  foreignObjects: {},
  waiverDeadline: null
};
let currentUser = null;
let claimRanked = [];
let wheelRotation = 0;
let isSpinning = false;

// ---------- Supabase helpers ----------
async function loadAllData() {
  const sb = window.supabaseClient;
  if (!sb) {
    console.error('Supabase client not ready');
    return;
  }

  // Teams
  const { data: teams, error: teamsErr } = await sb.from('teams').select('*');
  if (teamsErr) {
    console.error('Error loading teams:', teamsErr);
    alert('Could not load league data. Check Supabase connection.');
    return;
  }

  data.users = {};
  data.points = {};
  (teams || []).forEach(t => {
    data.users[t.pin] = {
      name: t.name,
      division: t.division,
      isCommissioner: t.is_commissioner,
      maxRoster: t.max_roster || 8,
      roster: t.roster || []
    };
    data.points[t.pin] = t.points || 0;
  });

  // Master roster
  const { data: master } = await sb.from('master_roster').select('name');
  data.masterRoster = (master || []).map(r => r.name).sort((a,b) => a.localeCompare(b));

  // Claims
  const { data: claims } = await sb.from('claims').select('*');
  data.claims = {};
  (claims || []).forEach(c => {
    data.claims[c.pin] = { ranked: c.ranked || [], submittedAt: c.submitted_at };
  });

  // Foreign objects
  const { data: fos } = await sb.from('foreign_objects').select('*');
  data.foreignObjects = {};
  (fos || []).forEach(fo => {
    if (!data.foreignObjects[fo.pin]) data.foreignObjects[fo.pin] = [];
    data.foreignObjects[fo.pin].push({
      id: fo.fo_type,
      name: FO_TYPES[fo.fo_type]?.name || fo.fo_type,
      banked: fo.banked,
      awardedAt: fo.awarded_at
    });
  });

  // Settings (waiver deadline)
  const { data: settings } = await sb.from('settings').select('*');
  const deadlineRow = (settings || []).find(s => s.key === 'waiver_deadline');
  data.waiverDeadline = deadlineRow ? deadlineRow.value : null;

  console.log('Live data loaded from Supabase');
  await loadTrades();
}

async function saveTeamPoints(pin, points) {
  await window.supabaseClient.from('teams').update({ points }).eq('pin', pin);
  data.points[pin] = points;
}

async function saveTeamRoster(pin, roster, maxRoster) {
  const payload = { roster };
  if (maxRoster !== undefined) payload.max_roster = maxRoster;
  await window.supabaseClient.from('teams').update(payload).eq('pin', pin);
  if (data.users[pin]) {
    data.users[pin].roster = roster;
    if (maxRoster !== undefined) data.users[pin].maxRoster = maxRoster;
  }
}

async function saveClaim(pin, ranked) {
  await window.supabaseClient.from('claims').upsert({
    pin,
    ranked,
    submitted_at: new Date().toISOString()
  });
  data.claims[pin] = { ranked, submittedAt: new Date().toISOString() };
}

async function clearClaim(pin) {
  await window.supabaseClient.from('claims').delete().eq('pin', pin);
  delete data.claims[pin];
}

async function saveMasterRoster(names) {
  // Simple approach: delete all + insert
  await window.supabaseClient.from('master_roster').delete().neq('id', 0);
  if (names.length) {
    const rows = names.map(name => ({ name }));
    await window.supabaseClient.from('master_roster').insert(rows);
  }
  data.masterRoster = names;
}

async function addMasterWrestler(name) {
  const { error } = await window.supabaseClient.from('master_roster').insert({ name });
  if (!error) {
    data.masterRoster.push(name);
    data.masterRoster.sort((a,b) => a.localeCompare(b));
  }
  return !error;
}

async function setWaiverDeadline(iso) {
  await window.supabaseClient.from('settings').upsert({ key: 'waiver_deadline', value: iso });
  data.waiverDeadline = iso;
}

// ---------- Auth ----------
function login(pin) {
  pin = pin.trim().toLowerCase();
  if (!pin || pin.length > 10 || !/^[a-z0-9]+$/i.test(pin)) {
    return { ok: false, error: 'PIN must be 1-10 letters or numbers only' };
  }
  if (!data.users[pin]) {
    return { ok: false, error: 'PIN not found. Ask Ford for your PIN.' };
  }
  currentUser = pin;
  localStorage.setItem('aew_current_pin', pin);
  return { ok: true };
}

function logout() {
  currentUser = null;
  localStorage.removeItem('aew_current_pin');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('pin-input').value = '';
}

function isCommissioner() {
  return currentUser && data.users[currentUser]?.isCommissioner;
}

// ---------- UI ----------
function showTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');

  if (tabId === 'standings') renderStandings();
  if (tabId === 'myteam') renderMyTeam();
  if (tabId === 'transactions') { renderWaiver(); }
  if (tabId === 'rules') renderScoringTable();
  if (tabId === 'commissioner') renderCommissioner();
}

function renderStandings() {
  const east = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'east')
    .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0, maxRoster: u.maxRoster }))
    .sort((a, b) => b.points - a.points);

  const west = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'west')
    .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0, maxRoster: u.maxRoster }))
    .sort((a, b) => b.points - a.points);

  const renderList = (list, containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = list.map((t, i) => `
      <div class="standing-row ${t.pin === currentUser ? 'me' : ''}">
        <div class="flex items-center gap-3">
          <span class="text-gray-500 w-5 text-right">${i + 1}</span>
          <span class="font-semibold">${t.name}</span>
          ${t.maxRoster > 8 ? '<span class="text-xs bg-emerald-900 text-emerald-300 px-1.5 py-0.5 rounded">9</span>' : ''}
        </div>
        <span class="font-bold text-lg">${t.points}</span>
      </div>
    `).join('');
  };

  renderList(east, 'east-standings');
  renderList(west, 'west-standings');
}

function renderMyTeam() {
  const u = data.users[currentUser];
  const el = document.getElementById('my-team-content');
  if (!u) return;

  if (u.isCommissioner && !u.division) {
    el.innerHTML = `<div class="text-center py-12 text-gray-500"><p>Commissioner view</p></div>`;
    return;
  }

  const pts = data.points[currentUser] || 0;
  const roster = u.roster || [];

  el.innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold">${u.name}</h2>
        <p class="text-gray-400 text-sm">${u.division === 'east' ? 'East Coast' : 'West Coast'} • Roster ${roster.length}/${u.maxRoster}</p>
      </div>
      <div class="text-right">
        <div class="text-3xl font-black text-aew-gold">${pts}</div>
        <div class="text-xs text-gray-500">Total Points</div>
      </div>
    </div>
    <div class="bg-aew-card rounded-xl border border-gray-800 p-4">
      <h3 class="font-semibold mb-3">Current Roster</h3>
      ${roster.length === 0
        ? '<p class="text-gray-500 text-sm">No wrestlers yet.</p>'
        : `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${roster.map(w => `<div class="bg-black/50 rounded-lg px-3 py-2 text-sm">${w}</div>`).join('')}
          </div>`}
    </div>
  `;
}

function getAvailableWrestlers(division = null) {
  if (!division && currentUser && data.users[currentUser]) {
    division = data.users[currentUser].division;
  }
  if (!division) return data.masterRoster.slice().sort();

  const taken = new Set();
  Object.values(data.users).forEach(u => {
    if (u.division === division) {
      (u.roster || []).forEach(w => taken.add(w));
    }
  });
  return data.masterRoster.filter(w => !taken.has(w)).sort();
}

function renderWaiver() {
  const available = getAvailableWrestlers();
  const container = document.getElementById('available-wrestlers');
  if (!container) return;

  if (available.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm p-4 text-center">No available wrestlers (upload master roster first)</p>';
  } else {
    container.innerHTML = available.map(w => `
      <div class="wrestler-chip px-3 py-2 rounded-lg text-sm border border-transparent hover:border-gray-600" data-name="${w}">
        ${w}
      </div>
    `).join('');
    container.querySelectorAll('.wrestler-chip').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.dataset.name;
        if (!claimRanked.includes(name)) {
          claimRanked.push(name);
          renderClaimList();
        }
      });
    });
  }

  if (data.claims[currentUser]) {
    claimRanked = [...(data.claims[currentUser].ranked || [])];
  }
  renderClaimList();
}

function renderClaimList() {
  const el = document.getElementById('claim-list');
  if (!el) return;
  if (claimRanked.length === 0) {
    el.innerHTML = '<p class="text-sm text-gray-500 text-center py-8">Click wrestlers on the left to add them in priority order</p>';
    return;
  }
  el.innerHTML = claimRanked.map((w, i) => `
    <div class="claim-item">
      <div class="flex items-center gap-2">
        <span class="text-gray-500 text-xs w-4">${i + 1}.</span>
        <span>${w}</span>
      </div>
      <button class="text-red-400 text-xs remove-claim" data-idx="${i}">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('.remove-claim').forEach(btn => {
    btn.addEventListener('click', () => {
      claimRanked.splice(parseInt(btn.dataset.idx), 1);
      renderClaimList();
    });
  });
}

function renderScoringTable() {
  const tbody = document.getElementById('scoring-table');
  if (!tbody) return;
  let html = '';
  let lastSection = '';
  SCORING.forEach(row => {
    if (row.section !== lastSection) {
      const labels = {
        'non-title': 'NON-TITLE',
        'non-aew': 'NON-AEW TITLES',
        'mid': 'MIDCARD TITLES (TNT / TBS / Int\'l / Tags / Continental)',
        'world': 'WORLD TITLES'
      };
      html += `<tr><td colspan="3" class="pt-4 pb-1 text-xs font-bold text-gray-500 uppercase tracking-wider">${labels[row.section] || ''}</td></tr>`;
      lastSection = row.section;
    }
    html += `
      <tr class="border-b border-gray-800/50">
        <td class="py-2 pr-4">${row.action}</td>
        <td class="text-center py-2 font-mono">${row.tv}</td>
        <td class="text-center py-2 font-mono">${row.ppv}</td>
      </tr>`;
  });
  tbody.innerHTML = html;
}

function renderCommissioner() {
  // Populate selects etc.
  const players = Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .map(([pin, u]) => ({ pin, name: u.name, division: u.division }));

  ['fo-award-player', 'fo-activate-player'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">Select player...</option>' +
      players.map(p => `<option value="${p.pin}">${p.name} (${p.division})</option>`).join('');
  });

  const heldEl = document.getElementById('fo-held-list');
  if (heldEl) {
    const entries = [];
    Object.entries(data.foreignObjects || {}).forEach(([pin, list]) => {
      const u = data.users[pin];
      if (!u) return;
      list.forEach(fo => {
        entries.push(`<div class="flex justify-between gap-2">
          <span>${u.name}</span>
          <span class="text-aew-gold">${fo.name}${fo.banked ? ' (banked)' : ''}</span>
        </div>`);
      });
    });
    heldEl.innerHTML = entries.length ? entries.join('') : '<p class="text-gray-500">None awarded yet</p>';
  }

  // Roster count
  const countEl = document.getElementById('roster-count');
  if (countEl) countEl.textContent = `${data.masterRoster.length} wrestlers currently in the pool`;

  const upload = document.getElementById('roster-upload');
  if (upload) upload.value = data.masterRoster.join('\n');

  updateDeadlineStatus();
  drawWheel();
}

// ---------- Wheel ----------
function drawWheel() {
  const canvas = document.getElementById('wheel-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const center = 128;
  const radius = 120;
  const segAngle = (2 * Math.PI) / WHEEL_SEGMENTS.length;
  ctx.clearRect(0, 0, 256, 256);
  WHEEL_SEGMENTS.forEach((seg, i) => {
    const start = i * segAngle - Math.PI / 2;
    const end = start + segAngle;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.arc(center, center, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(start + segAngle / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    const lines = seg.label.split('\n');
    lines.forEach((line, li) => {
      ctx.fillText(line, radius * 0.62, (li - (lines.length - 1) / 2) * 13);
    });
    ctx.restore();
  });
  ctx.beginPath();
  ctx.arc(center, center, 18, 0, 2 * Math.PI);
  ctx.fillStyle = '#111';
  ctx.fill();
  ctx.strokeStyle = '#f5c518';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function spinWheel() {
  if (isSpinning) return;
  isSpinning = true;
  document.getElementById('wheel-result').textContent = 'Spinning...';
  const segAngle = 360 / WHEEL_SEGMENTS.length;
  const randomIndex = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
  const extraSpins = 5 + Math.random() * 3;
  const targetRotation = extraSpins * 360 + (360 - randomIndex * segAngle - segAngle / 2);
  wheelRotation = targetRotation;
  const canvas = document.getElementById('wheel-canvas');
  canvas.style.transform = `rotate(${wheelRotation}deg)`;
  setTimeout(() => {
    const result = WHEEL_SEGMENTS[randomIndex];
    const region = document.getElementById('wheel-region')?.value || 'east';
    document.getElementById('wheel-result').innerHTML =
      `<span class="text-aew-gold">${result.label.replace('\n', ' ')}</span><br><span class="text-sm text-gray-400">${region.toUpperCase()} region</span>`;
    isSpinning = false;
  }, 4200);
}

// ---------- Coin Flip ----------
function flipCoin() {
  const a = document.getElementById('coin-team-a')?.value.trim() || 'Team A';
  const b = document.getElementById('coin-team-b')?.value.trim() || 'Team B';
  const winner = Math.random() < 0.5 ? a : b;
  document.getElementById('coin-result').innerHTML =
    `<span class="text-aew-gold">${winner}</span> wins the flip`;
}

// ---------- Waiver processing ----------
async function processWaivers() {
  const log = document.getElementById('waiver-log');
  if (log) log.innerHTML = '<p class="text-gray-400">Processing...</p>';
  const results = [];

  for (const div of ['east', 'west']) {
    const order = Object.entries(data.users)
      .filter(([_, u]) => u.division === div)
      .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0 }))
      .sort((a, b) => a.points - b.points);

    for (const team of order) {
      const claim = data.claims[team.pin];
      if (!claim || !claim.ranked || claim.ranked.length === 0) continue;

      for (const wrestler of claim.ranked) {
        const available = getAvailableWrestlers(div);
        if (available.includes(wrestler)) {
          const u = data.users[team.pin];
          if ((u.roster || []).length < u.maxRoster) {
            u.roster = u.roster || [];
            u.roster.push(wrestler);
            await saveTeamRoster(team.pin, u.roster);
            await clearClaim(team.pin);
            results.push(`✅ ${team.name} claimed <strong>${wrestler}</strong>`);
            break;
          } else {
            results.push(`⚠️ ${team.name} wanted ${wrestler} but roster is full`);
          }
        }
      }
    }
  }

  if (log) {
    log.innerHTML = results.length
      ? results.map(r => `<div class="py-1 border-b border-gray-800">${r}</div>`).join('')
      : '<p class="text-gray-500">No successful claims this run.</p>';
  }
  renderStandings();
}

// ---------- Deadline ----------
function updateDeadlineStatus() {
  const el = document.getElementById('waiver-deadline-status');
  if (!el) return;
  if (!data.waiverDeadline) {
    el.innerHTML = '<span class="text-gray-500">No deadline set</span>';
    return;
  }
  const deadline = new Date(data.waiverDeadline);
  const now = new Date();
  const diff = deadline - now;
  if (diff <= 0) {
    el.innerHTML = `<span class="text-aew-gold font-bold">Deadline passed</span><br>
                    <span class="text-xs text-gray-400">Set: ${deadline.toLocaleString()}</span>`;
  } else {
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    el.innerHTML = `<span class="text-emerald-400">Deadline: ${deadline.toLocaleString()}</span><br>
                    <span class="text-xs text-gray-400">Time remaining: ${hours}h ${mins}m</span>`;
  }
}

async function setWaiverDeadlineUI() {
  const date = document.getElementById('waiver-date')?.value;
  const time = document.getElementById('waiver-time')?.value;
  if (!date || !time) return alert('Pick both a date and time');
  const deadline = new Date(`${date}T${time}`);
  if (isNaN(deadline.getTime())) return alert('Invalid date/time');
  await setWaiverDeadline(deadline.toISOString());
  updateDeadlineStatus();
  alert(`Waiver deadline set to ${deadline.toLocaleString()}`);
}

// ---------- Boot ----------
async function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const u = data.users[currentUser];
  document.getElementById('user-badge').textContent = u.name + (u.isCommissioner ? ' ⭐' : '');

  if (u.isCommissioner) {
    document.getElementById('commish-nav')?.classList.remove('hidden');
  } else {
    document.getElementById('commish-nav')?.classList.add('hidden');
  }
  showTab('standings');
}


function renderLeagueRosters() {
  const el = document.getElementById('league-rosters-view');
  if (!el) return;

  const east = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'east')
    .sort((a, b) => (data.points[b[0]] || 0) - (data.points[a[0]] || 0));

  const west = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'west')
    .sort((a, b) => (data.points[b[0]] || 0) - (data.points[a[0]] || 0));

  const renderDivision = (teams, title, color) => {
    return `
      <div>
        <h3 class="text-lg font-bold mb-3 ${color}">${title}</h3>
        <div class="space-y-3">
          ${teams.map(([pin, u]) => `
            <div class="bg-aew-card rounded-xl border border-gray-800 p-4">
              <div class="flex justify-between items-center mb-2">
                <span class="font-semibold">${u.name}</span>
                <span class="text-sm text-gray-400">${(u.roster || []).length}/${u.maxRoster} • ${data.points[pin] || 0} pts</span>
              </div>
              <div class="flex flex-wrap gap-1.5">
                ${(u.roster || []).map(w => `<span class="text-xs bg-black/60 border border-gray-700 rounded px-2 py-1">${w}</span>`).join('') || '<span class="text-gray-500 text-sm">Empty roster</span>'}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  };

  el.innerHTML = `
    <div class="grid md:grid-cols-2 gap-8">
      ${renderDivision(east, 'East Coast', 'text-blue-400')}
      ${renderDivision(west, 'West Coast', 'text-orange-400')}
    </div>
  `;
}

// Sub-tab switching for Transactions
document.addEventListener('click', (e) => {
  if (e.target.id === 'tx-tab-waivers') {
    document.getElementById('tx-waivers-panel')?.classList.remove('hidden');
    document.getElementById('tx-rosters-panel')?.classList.add('hidden');
    e.target.className = 'px-4 py-2 rounded-lg text-sm font-medium bg-aew-red text-white';
    document.getElementById('tx-tab-rosters').className = 'px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 text-gray-300';
  }
  if (e.target.id === 'tx-tab-rosters') {
    document.getElementById('tx-waivers-panel')?.classList.add('hidden');
    document.getElementById('tx-rosters-panel')?.classList.remove('hidden');
    e.target.className = 'px-4 py-2 rounded-lg text-sm font-medium bg-aew-red text-white';
    document.getElementById('tx-tab-waivers').className = 'px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 text-gray-300';
    renderLeagueRosters();
  }
});



// ---------- Trades ----------
async function loadTrades() {
  const { data: trades } = await window.supabaseClient
    .from('trades')
    .select('*')
    .in('status', ['pending', 'accepted_by_player']);
  data.pendingTrades = trades || [];
  updateTradeBanner();
}

function updateTradeBanner() {
  const banner = document.getElementById('pending-trades-banner');
  const text = document.getElementById('pending-trades-text');
  if (!banner || !text) return;

  const mine = (data.pendingTrades || []).filter(t => t.to_pin === currentUser);
  if (mine.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const fromNames = mine.map(t => data.users[t.from_pin]?.name || t.from_pin).join(', ');
  text.textContent = `You have ${mine.length} pending trade offer${mine.length > 1 ? 's' : ''} from ${fromNames}`;
}

async function proposeTrade(toPin, offering, requesting) {
  if (!offering.length || !requesting.length) {
    alert('Select at least one wrestler on each side');
    return;
  }
  const { error } = await window.supabaseClient.from('trades').insert({
    from_pin: currentUser,
    to_pin: toPin,
    offering,
    requesting,
    status: 'pending'
  });
  if (error) {
    alert('Failed to submit trade: ' + error.message);
    return;
  }
  alert('Trade offer sent!');
  await loadTrades();
}

async function resolveTrade(tradeId, accept) {
  const trade = (data.pendingTrades || []).find(t => t.id === tradeId);
  if (!trade) return;

  // Player accepting → moves to "accepted_by_player" (needs commissioner approval)
  // Commissioner approving → actually executes the swap
  // Anyone rejecting / vetoing → closes it

  const isCommish = data.users[currentUser]?.isCommissioner;

  if (accept) {
    if (isCommish && trade.status === 'accepted_by_player') {
      // Commissioner final approval → execute the swap
      const fromUser = data.users[trade.from_pin];
      const toUser = data.users[trade.to_pin];
      if (!fromUser || !toUser) return alert('Team data missing');

      fromUser.roster = (fromUser.roster || []).filter(w => !trade.offering.includes(w));
      fromUser.roster.push(...trade.requesting);

      toUser.roster = (toUser.roster || []).filter(w => !trade.requesting.includes(w));
      toUser.roster.push(...trade.offering);

      if (fromUser.roster.length > fromUser.maxRoster || toUser.roster.length > toUser.maxRoster) {
        alert('Trade would put a team over roster limit. Vetoed for safety.');
        await window.supabaseClient.from('trades')
          .update({ status: 'vetoed', resolved_at: new Date().toISOString() })
          .eq('id', tradeId);
        await loadTrades();
        renderLeagueRosters();
        return;
      }

      await saveTeamRoster(trade.from_pin, fromUser.roster);
      await saveTeamRoster(trade.to_pin, toUser.roster);

      await window.supabaseClient.from('trades')
        .update({ status: 'accepted', resolved_at: new Date().toISOString() })
        .eq('id', tradeId);

      await loadTrades();
      await loadAllData();
      renderLeagueRosters();
      updateTradeBanner();
      alert('Trade approved by commissioner. Rosters updated.');
      return;
    }

    // Regular player accepting → needs commissioner OK
    await window.supabaseClient.from('trades')
      .update({ status: 'accepted_by_player' })
      .eq('id', tradeId);

    await loadTrades();
    renderLeagueRosters();
    updateTradeBanner();
    alert('You accepted the trade. It now needs commissioner (Devin) approval before it goes through.');
    return;
  }

  // Reject or Veto
  const newStatus = isCommish ? 'vetoed' : 'rejected';
  await window.supabaseClient.from('trades')
    .update({ status: newStatus, resolved_at: new Date().toISOString() })
    .eq('id', tradeId);

  await loadTrades();
  renderLeagueRosters();
  updateTradeBanner();
  alert(isCommish ? 'Trade vetoed by commissioner.' : 'Trade rejected.');
}

function showTradeModal(toPin) {
  const toUser = data.users[toPin];
  const fromUser = data.users[currentUser];
  if (!toUser || !fromUser) return;

  // Simple prompt-based for now (can be upgraded to a nicer modal later)
  const myRoster = (fromUser.roster || []).join('\n');
  const theirRoster = (toUser.roster || []).join('\n');

  const offeringStr = prompt(
    `TRADE WITH ${toUser.name}\n\nYour roster:\n${myRoster}\n\nEnter the wrestler(s) YOU are offering (comma separated):`
  );
  if (offeringStr === null) return;
  const offering = offeringStr.split(',').map(s => s.trim()).filter(Boolean);

  const requestingStr = prompt(
    `Their roster:\n${theirRoster}\n\nEnter the wrestler(s) you want FROM them (comma separated):`
  );
  if (requestingStr === null) return;
  const requesting = requestingStr.split(',').map(s => s.trim()).filter(Boolean);

  // Basic validation
  for (const w of offering) {
    if (!(fromUser.roster || []).includes(w)) {
      alert(`You don't have "${w}" on your roster`);
      return;
    }
  }
  for (const w of requesting) {
    if (!(toUser.roster || []).includes(w)) {
      alert(`${toUser.name} doesn't have "${w}"`);
      return;
    }
  }

  proposeTrade(toPin, offering, requesting);
}

// Enhance renderLeagueRosters to include Propose Trade buttons and pending trade review
const _origRenderLeagueRosters = typeof renderLeagueRosters === 'function' ? renderLeagueRosters : null;

renderLeagueRosters = function() {
  const el = document.getElementById('league-rosters-view');
  if (!el) return;

  const east = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'east')
    .sort((a, b) => (data.points[b[0]] || 0) - (data.points[a[0]] || 0));

  const west = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'west')
    .sort((a, b) => (data.points[b[0]] || 0) - (data.points[a[0]] || 0));

  // Pending trades involving current user
  const isCommish = data.users[currentUser]?.isCommissioner;
  const incoming = (data.pendingTrades || []).filter(t => 
    isCommish ? (t.status === 'accepted_by_player' || t.to_pin === currentUser) : t.to_pin === currentUser
  );
  const outgoing = (data.pendingTrades || []).filter(t => t.from_pin === currentUser);

  let pendingHtml = '';
  if (incoming.length || outgoing.length) {
    pendingHtml = `<div class="mb-6 space-y-3">
      <h3 class="font-bold text-aew-gold">Pending Trades</h3>`;
    incoming.forEach(t => {
      const fromName = data.users[t.from_pin]?.name || t.from_pin;
      const isCommish = data.users[currentUser]?.isCommissioner;
      const waitingForCommish = t.status === 'accepted_by_player';

      let buttons = '';
      if (isCommish && waitingForCommish) {
        buttons = `
          <button onclick="resolveTrade(${t.id}, true)" class="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold px-4 py-1.5 rounded-lg">Approve Trade</button>
          <button onclick="resolveTrade(${t.id}, false)" class="bg-red-700 hover:bg-red-600 text-white text-sm px-4 py-1.5 rounded-lg">Veto</button>`;
      } else if (!waitingForCommish) {
        buttons = `
          <button onclick="resolveTrade(${t.id}, true)" class="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold px-4 py-1.5 rounded-lg">Accept</button>
          <button onclick="resolveTrade(${t.id}, false)" class="bg-gray-700 hover:bg-gray-600 text-white text-sm px-4 py-1.5 rounded-lg">Reject</button>`;
      } else {
        buttons = `<span class="text-xs text-aew-gold">Waiting for commissioner approval...</span>`;
      }

      pendingHtml += `
        <div class="bg-aew-card border border-aew-gold/40 rounded-xl p-4">
          <div class="text-sm mb-2"><span class="font-semibold">${fromName}</span> offers:</div>
          <div class="text-sm text-gray-300 mb-1">Giving you: <span class="text-white">${(t.offering || []).join(', ')}</span></div>
          <div class="text-sm text-gray-300 mb-3">Wants from you: <span class="text-white">${(t.requesting || []).join(', ')}</span></div>
          <div class="flex gap-2 items-center">${buttons}</div>
        </div>`;
    });
    outgoing.forEach(t => {
      const toName = data.users[t.to_pin]?.name || t.to_pin;
      pendingHtml += `
        <div class="bg-aew-card border border-gray-700 rounded-xl p-4 opacity-80">
          <div class="text-sm text-gray-400">You offered to <span class="text-white">${toName}</span> (waiting for response)</div>
          <div class="text-xs text-gray-500 mt-1">Giving: ${(t.offering || []).join(', ')} • Requesting: ${(t.requesting || []).join(', ')}</div>
        </div>`;
    });
    pendingHtml += `</div>`;
  }

  const renderDivision = (teams, title, color) => {
    return `
      <div>
        <h3 class="text-lg font-bold mb-3 ${color}">${title}</h3>
        <div class="space-y-3">
          ${teams.map(([pin, u]) => {
            const isMe = pin === currentUser;
            const sameDiv = data.users[currentUser]?.division === u.division;
            const canTrade = !isMe && sameDiv;
            return `
            <div class="bg-aew-card rounded-xl border border-gray-800 p-4">
              <div class="flex justify-between items-center mb-2">
                <span class="font-semibold">${u.name}${isMe ? ' (you)' : ''}</span>
                <div class="flex items-center gap-2">
                  <span class="text-sm text-gray-400">${(u.roster || []).length}/${u.maxRoster} • ${data.points[pin] || 0} pts</span>
                  ${canTrade ? `<button onclick="showTradeModal('${pin}')" class="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded">Propose Trade</button>` : ''}
                </div>
              </div>
              <div class="flex flex-wrap gap-1.5">
                ${(u.roster || []).map(w => `<span class="text-xs bg-black/60 border border-gray-700 rounded px-2 py-1">${w}</span>`).join('') || '<span class="text-gray-500 text-sm">Empty roster</span>'}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  };

  const myDiv = data.users[currentUser]?.division;
  let divisionHtml = '';
  if (myDiv === 'east') {
    divisionHtml = renderDivision(east, 'East Coast', 'text-blue-400');
  } else if (myDiv === 'west') {
    divisionHtml = renderDivision(west, 'West Coast', 'text-orange-400');
  } else {
    // Commissioner sees both
    divisionHtml = `
      <div class="grid md:grid-cols-2 gap-8">
        ${renderDivision(east, 'East Coast', 'text-blue-400')}
        ${renderDivision(west, 'West Coast', 'text-orange-400')}
      </div>`;
  }

  el.innerHTML = pendingHtml + divisionHtml;
};

// Make resolveTrade available globally for the onclick handlers
window.resolveTrade = resolveTrade;
window.showTradeModal = showTradeModal;


document.addEventListener('DOMContentLoaded', async () => {
  // Load live data first
  await loadAllData();

  // Restore session
  const savedPin = localStorage.getItem('aew_current_pin');
  if (savedPin && data.users[savedPin]) {
    currentUser = savedPin;
    enterApp();
  }

  // Login
  document.getElementById('login-btn')?.addEventListener('click', async () => {
    const pin = document.getElementById('pin-input').value;
    const res = login(pin);
    if (res.ok) {
      await loadAllData(); // refresh
      enterApp();
    } else {
      const err = document.getElementById('login-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
    }
  });

  document.getElementById('pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn')?.click();
  });

  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.getElementById('view-pending-trades')?.addEventListener('click', () => {
    showTab('transactions');
    // Switch to rosters subtab
    document.getElementById('tx-tab-rosters')?.click();
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Waiver claim submit
  document.getElementById('clear-claim')?.addEventListener('click', () => {
    claimRanked = [];
    renderClaimList();
  });

  document.getElementById('submit-claim')?.addEventListener('click', async () => {
    if (claimRanked.length === 0) {
      document.getElementById('claim-status').textContent = 'Add at least one wrestler';
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-red-400';
      return;
    }
    await saveClaim(currentUser, [...claimRanked]);
    document.getElementById('claim-status').textContent = 'Claim submitted successfully';
    document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-emerald-400';
  });

  // Commissioner buttons
  document.getElementById('save-roster')?.addEventListener('click', async () => {
    const text = document.getElementById('roster-upload').value;
    const names = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    await saveMasterRoster(names);
    document.getElementById('roster-count').textContent = `${names.length} wrestlers currently in the pool`;
    alert(`Saved ${names.length} wrestlers to the master pool.`);
  });

  document.getElementById('add-wrestler-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('add-wrestler-name');
    const msg = document.getElementById('add-wrestler-msg');
    const name = (input?.value || '').trim();
    if (!name) {
      if (msg) { msg.textContent = 'Enter a wrestler name'; msg.className = 'text-sm mt-2 text-red-400'; }
      return;
    }
    if (data.masterRoster.some(w => w.toLowerCase() === name.toLowerCase())) {
      if (msg) { msg.textContent = `"${name}" is already in the master pool`; msg.className = 'text-sm mt-2 text-yellow-400'; }
      return;
    }
    const ok = await addMasterWrestler(name);
    if (ok) {
      input.value = '';
      document.getElementById('roster-upload').value = data.masterRoster.join('\n');
      document.getElementById('roster-count').textContent = `${data.masterRoster.length} wrestlers currently in the pool`;
      if (msg) {
        msg.textContent = `Added "${name}" to the master pool`;
        msg.className = 'text-sm mt-2 text-emerald-400';
        setTimeout(() => { msg.textContent = ''; }, 4000);
      }
    }
  });

  document.getElementById('spin-wheel')?.addEventListener('click', spinWheel);
  document.getElementById('flip-coin')?.addEventListener('click', flipCoin);
  document.getElementById('process-waivers')?.addEventListener('click', processWaivers);
  document.getElementById('set-waiver-deadline')?.addEventListener('click', setWaiverDeadlineUI);

  // CSV upload
  const csvInput = document.getElementById('roster-csv');
  if (csvInput) {
    csvInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const text = ev.target.result;
        const names = text.split(/\r?\n/)
          .map(line => line.split(',')[0].replace(/^"|"$/g, '').trim())
          .filter(name => name.length > 0 && name.toLowerCase() !== 'name' && name.toLowerCase() !== 'wrestler');
        document.getElementById('roster-upload').value = names.join('\n');
        await saveMasterRoster(names);
        document.getElementById('roster-count').textContent = `${names.length} wrestlers currently in the pool`;
        alert(`Loaded ${names.length} wrestlers from file.`);
      };
      reader.readAsText(file);
    });
  }
});
