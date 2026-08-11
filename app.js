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
  console.log('Loaded PINs:', Object.keys(data.users));


  // Master roster
  const { data: master } = await sb.from('master_roster').select('name');
  data.masterRoster = (master || []).map(r => r.name).sort((a,b) => a.localeCompare(b));

  // Claims
  const { data: claims } = await sb.from('claims').select('*');
  data.claims = {};
  (claims || []).forEach(c => {
    data.claims[c.pin] = { ranked: c.ranked || [], drop: c.drop || null, submittedAt: c.submitted_at };
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
  await loadChampions();
  await loadWrestlerPoints();
  await updateDraftScheduleBanner();
  // pending alerts checked in enterApp
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

async function saveClaim(pin, ranked, drop = null) {
  const payload = {
    pin,
    ranked,
    drop: drop || null,
    submitted_at: new Date().toISOString()
  };
  await window.supabaseClient.from('claims').upsert(payload);
  data.claims[pin] = { ranked, drop, submittedAt: new Date().toISOString() };
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
  pin = (pin || '').trim().toLowerCase();
  console.log('Login attempt:', pin, 'Available:', Object.keys(data.users));
  if (!pin || pin.length > 10 || !/^[a-z0-9]+$/i.test(pin)) {
    return { ok: false, error: 'PIN must be 1-10 letters or numbers only' };
  }
  if (!data.users[pin]) {
    return { ok: false, error: 'PIN not found. Available: ' + Object.keys(data.users).join(', ') };
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
  // Soft refresh data when switching tabs (except first paint)
  if (currentUser) softRefresh(false);
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');

  if (tabId === 'standings') renderStandings();
  if (tabId === 'myteam') renderMyTeam();
  if (tabId === 'transactions') { renderWaiver(); }
  if (tabId === 'draft') { renderDraft(); }
  if (tabId === 'broadcast') { renderBroadcastTab(); }
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
            ${roster.map(w => {
        const label = championLabel(w);
        const gold = label ? 'text-aew-gold font-semibold' : '';
        const badge = label ? `<span class="ml-1.5 text-[10px] bg-aew-gold/20 text-aew-gold px-1.5 py-0.5 rounded">${label}</span>` : '';
        const pts = getWrestlerPts(w);
        return `<div class="bg-black/50 rounded-lg px-3 py-2 text-sm ${gold} flex items-center justify-between gap-2">
          <span class="flex items-center">${w}${badge}</span>
          <span class="text-gray-400 font-mono text-xs">${pts}</span>
        </div>`;
      }).join('')}
          </div>`}
    </div>
  `;
}

function getAvailableWrestlers(division = null) {
  if (!division && currentUser && data.users[currentUser]) {
    division = data.users[currentUser].division;
  }
  if (!division) return data.masterRoster.slice().sort((a,b) => a.localeCompare(b));

  // Case-insensitive set of taken names in this division
  const taken = new Set();
  Object.values(data.users).forEach(u => {
    if (u.division === division) {
      (u.roster || []).forEach(w => taken.add(w.toLowerCase().trim()));
    }
  });
  return data.masterRoster
    .filter(w => !taken.has(w.toLowerCase().trim()))
    .sort((a,b) => a.localeCompare(b));
}

function renderWaiver() {
  updateWaiverDeadlineBanner();
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
  
  renderWaiverFOStatus();

  // Populate drop dropdown with current roster
  const dropSel = document.getElementById('drop-select');
  if (dropSel) {
    const roster = data.users[currentUser]?.roster || [];
    dropSel.innerHTML = '<option value="">Select wrestler to drop...</option>' +
      roster.map(w => `<option value="${w}">${w}</option>`).join('');
    // Restore previously saved drop if any
    if (data.claims[currentUser]?.drop) {
      dropSel.value = data.claims[currentUser].drop;
    }
  }
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
  renderChampionsEditor();
  renderForeignObjects();
  renderScoreInputs();
  renderWaiverReports();
  const scoreEvent = document.getElementById('score-event');
  if (scoreEvent && scoreEvent.options.length <= 1) {
    const events = ['Dynamite', 'Collision', 'Rampage', 'PPV / Special', 'Foreign Object', 'Other'];
    events.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      scoreEvent.appendChild(opt);
    });
  }
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

    // Check if Waiver Disrupter is active for this division
    let disrupterPin = null;
    try {
      const { data: sett } = await window.supabaseClient.from('settings').select('value').eq('key', 'waiver_disrupter_' + div).maybeSingle();
      disrupterPin = sett?.value || null;
    } catch(e) {}

    for (const team of order) {
      const claim = data.claims[team.pin];
      if (!claim || !claim.ranked || claim.ranked.length === 0) continue;

      // Disrupter: everyone except the activator fails their first attempt
      if (disrupterPin && team.pin !== disrupterPin) {
        results.push(`🚫 ${team.name} — first claim blocked by Waiver Disrupter`);
        // Remove only their first choice so they could still get a later one if we supported multi, but for now clear the claim attempt effect
        // We "fail first attempt" by skipping their entire claim this run (simple interpretation)
        await clearClaim(team.pin);
        continue;
      }

      for (const wrestler of claim.ranked) {
        const available = getAvailableWrestlers(div);
        if (available.includes(wrestler)) {
          const u = data.users[team.pin];
          const drop = claim.drop;
          u.roster = u.roster || [];
          
          if (drop && u.roster.includes(drop)) {
            u.roster = u.roster.filter(w => w !== drop);
            u.roster.push(wrestler);
            await saveTeamRoster(team.pin, u.roster);
            await clearClaim(team.pin);
            results.push(`✅ ${team.name} claimed <strong>${wrestler}</strong> (dropped ${drop})`);
            break;
          } else if (u.roster.length < u.maxRoster) {
            u.roster.push(wrestler);
            await saveTeamRoster(team.pin, u.roster);
            await clearClaim(team.pin);
            results.push(`✅ ${team.name} claimed <strong>${wrestler}</strong>`);
            break;
          } else {
            results.push(`⚠️ ${team.name} wanted ${wrestler} but no valid drop selected / roster full`);
          }
        }
      }
    }

    // Clear the disrupter flag after processing this division
    if (disrupterPin) {
      await window.supabaseClient.from('settings').delete().eq('key', 'waiver_disrupter_' + div);
    }
  }

  const reportText = results.length ? results.join('\n') : 'No successful claims this run.';
  if (log) {
    log.innerHTML = results.length
      ? results.map(r => `<div class="py-1 border-b border-gray-800">${r}</div>`).join('')
      : '<p class="text-gray-500">No successful claims this run.</p>';
  }

  // Save persistent report for commissioner
  try {
    await window.supabaseClient.from('waiver_reports').insert({
      division: 'both',
      report: reportText
    });
  } catch (e) {
    console.error('Could not save waiver report:', e);
  }

  // Notify commissioner via RED ALERT
  try {
    const commishPin = Object.entries(data.users).find(([_, u]) => u.isCommissioner)?.[0];
    if (commishPin) {
      await window.supabaseClient.from('broadcasts').insert({
        from_pin: 'system',
        target: commishPin,
        message: 'WAIVER WIRE REPORT\n\n' + reportText
      });
    }
  } catch (e) {
    console.error('Could not notify commissioner of waiver results:', e);
  }

  renderStandings();
}

async function renderWaiverReports() {
  const el = document.getElementById('waiver-reports-list');
  if (!el) return;
  const { data: rows } = await window.supabaseClient
    .from('waiver_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  if (!rows || !rows.length) {
    el.innerHTML = '<p class="text-gray-500 text-sm">No waiver runs yet</p>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="bg-black/40 rounded-lg px-3 py-2 border border-gray-800 mb-2">
      <div class="text-xs text-gray-500 mb-1">${new Date(r.created_at).toLocaleString()}</div>
      <pre class="text-sm text-gray-300 whitespace-pre-wrap font-sans">${r.report}</pre>
    </div>
  `).join('');
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
  updateWaiverDeadlineBanner();
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
    document.getElementById('broadcast-nav')?.classList.remove('hidden');
  } else {
    document.getElementById('commish-nav')?.classList.add('hidden');
    document.getElementById('broadcast-nav')?.classList.add('hidden');
  }
  // Check for pending RED ALERTs
  loadPendingBroadcasts();
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
                ${(u.roster || []).map(w => {
                  const label = championLabel(w);
                  const gold = label ? 'text-aew-gold border-aew-gold/50 font-semibold' : 'border-gray-700';
                  const badge = label ? ` <span class="text-[9px] opacity-80">${label}</span>` : '';
                  const pts = getWrestlerPts(w);
                  return `<span class="text-xs bg-black/60 border rounded px-2 py-1 ${gold}">${w}${badge} <span class="text-gray-500">${pts}</span></span>`;
                }).join('') || '<span class="text-gray-500 text-sm">Empty roster</span>'}
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


async function notifyTradeUpdate(toPin, message) {
  if (!toPin || !message) return;
  try {
    await window.supabaseClient.from('broadcasts').insert({
      from_pin: currentUser || 'system',
      target: toPin,
      message: message
    });
  } catch (e) {
    console.error('Trade notify error:', e);
  }
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
      const fromNameA = data.users[trade.from_pin]?.name || trade.from_pin;
      const toNameA = data.users[trade.to_pin]?.name || trade.to_pin;
      const descA = `Giving: ${(trade.offering || []).join(', ')} | Requesting: ${(trade.requesting || []).join(', ')}`;
      await notifyTradeUpdate(trade.from_pin, `RED ALERT: Your trade with ${toNameA} was APPROVED.\n${descA}\nRosters have been updated.`);
      await notifyTradeUpdate(trade.to_pin, `RED ALERT: Your trade with ${fromNameA} was APPROVED.\n${descA}\nRosters have been updated.`);
      alert('Trade approved. Both sides notified. Rosters updated.');
      return;
    }

    // Regular player accepting → needs commissioner OK
    await window.supabaseClient.from('trades')
      .update({ status: 'accepted_by_player' })
      .eq('id', tradeId);

    await loadTrades();
    renderLeagueRosters();
    updateTradeBanner();
    const toNameP = data.users[currentUser]?.name || currentUser;
      await notifyTradeUpdate(trade.from_pin, `RED ALERT: ${toNameP} accepted your trade offer. It is waiting for commissioner approval.\nGiving: ${(trade.offering || []).join(', ')} | Requesting: ${(trade.requesting || []).join(', ')}`);
      alert('You accepted the trade. It now needs commissioner (Devin) approval. The other player has been notified.');
    return;
  }

  // Reject or Veto
  const newStatus = isCommish ? 'vetoed' : 'rejected';
  await window.supabaseClient.from('trades')
    .update({ status: newStatus, resolved_at: new Date().toISOString() })
    .eq('id', tradeId);

  const fromName = data.users[trade.from_pin]?.name || trade.from_pin;
  const toName = data.users[trade.to_pin]?.name || trade.to_pin;
  const offerDesc = `Giving: ${(trade.offering || []).join(', ')} | Requesting: ${(trade.requesting || []).join(', ')}`;

  if (isCommish) {
    // Notify both parties of veto
    await notifyTradeUpdate(trade.from_pin, `RED ALERT: Your trade with ${toName} was VETOED by the commissioner.\n${offerDesc}`);
    await notifyTradeUpdate(trade.to_pin, `RED ALERT: The trade between you and ${fromName} was VETOED by the commissioner.\n${offerDesc}`);
  } else {
    // Notify the proposer that it was rejected
    await notifyTradeUpdate(trade.from_pin, `RED ALERT: ${toName} REJECTED your trade offer.\n${offerDesc}`);
  }

  await loadTrades();
  renderLeagueRosters();
  updateTradeBanner();
  alert(isCommish ? 'Trade vetoed. Both sides have been notified.' : 'Trade rejected. The other player has been notified.');
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
                ${(u.roster || []).map(w => {
                  const label = championLabel(w);
                  const gold = label ? 'text-aew-gold border-aew-gold/50 font-semibold' : 'border-gray-700';
                  const badge = label ? ` <span class="text-[9px] opacity-80">${label}</span>` : '';
                  const pts = getWrestlerPts(w);
                  return `<span class="text-xs bg-black/60 border rounded px-2 py-1 ${gold}">${w}${badge} <span class="text-gray-500">${pts}</span></span>`;
                }).join('') || '<span class="text-gray-500 text-sm">Empty roster</span>'}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  };

  const myDiv = data.users[currentUser]?.division;
  // isCommish already declared above
  let divisionHtml = '';
  if (isCommish) {
    // Commissioner always sees both divisions
    divisionHtml = `
      <div class="grid md:grid-cols-2 gap-8">
        ${renderDivision(east, 'East Coast', 'text-blue-400')}
        ${renderDivision(west, 'West Coast', 'text-orange-400')}
      </div>`;
  } else if (myDiv === 'east') {
    divisionHtml = renderDivision(east, 'East Coast', 'text-blue-400');
  } else if (myDiv === 'west') {
    divisionHtml = renderDivision(west, 'West Coast', 'text-orange-400');
  }

  el.innerHTML = pendingHtml + divisionHtml;
};

// Make resolveTrade available globally for the onclick handlers
window.resolveTrade = resolveTrade;
window.showTradeModal = showTradeModal;



async function changePin() {
  const newPin = (document.getElementById('new-pin-input')?.value || '').trim().toLowerCase();
  const confirmPin = (document.getElementById('confirm-pin-input')?.value || '').trim().toLowerCase();
  const msg = document.getElementById('change-pin-msg');

  if (!newPin || newPin.length > 10 || !/^[a-z0-9]+$/i.test(newPin)) {
    if (msg) { msg.textContent = 'PIN must be 1–10 letters or numbers only'; msg.className = 'text-sm mt-2 text-red-400'; }
    return;
  }
  if (newPin !== confirmPin) {
    if (msg) { msg.textContent = 'PINs do not match'; msg.className = 'text-sm mt-2 text-red-400'; }
    return;
  }
  if (data.users[newPin]) {
    if (msg) { msg.textContent = 'That PIN is already taken'; msg.className = 'text-sm mt-2 text-red-400'; }
    return;
  }
  if (newPin === currentUser) {
    if (msg) { msg.textContent = 'That is already your PIN'; msg.className = 'text-sm mt-2 text-yellow-400'; }
    return;
  }

  const oldPin = currentUser;
  const sb = window.supabaseClient;

  try {
    // 1. Create the new team row (copy of old)
    const old = data.users[oldPin];
    const { error: insertErr } = await sb.from('teams').insert({
      pin: newPin,
      name: old.name,
      division: old.division,
      is_commissioner: old.isCommissioner,
      max_roster: old.maxRoster,
      roster: old.roster || [],
      points: data.points[oldPin] || 0
    });
    if (insertErr) throw insertErr;

    // 2. Move related data
    await sb.from('claims').update({ pin: newPin }).eq('pin', oldPin);
    await sb.from('foreign_objects').update({ pin: newPin }).eq('pin', oldPin);
    await sb.from('trades').update({ from_pin: newPin }).eq('from_pin', oldPin);
    await sb.from('trades').update({ to_pin: newPin }).eq('to_pin', oldPin);

    // 3. Delete the old team row
    await sb.from('teams').delete().eq('pin', oldPin);

    // 4. Update local state and re-login
    data.users[newPin] = { ...old };
    data.points[newPin] = data.points[oldPin] || 0;
    delete data.users[oldPin];
    delete data.points[oldPin];

    currentUser = newPin;
    localStorage.setItem('aew_current_pin', newPin);

    if (msg) {
      msg.textContent = `PIN changed to "${newPin}". You are now logged in with the new PIN.`;
      msg.className = 'text-sm mt-2 text-emerald-400';
    }
    document.getElementById('new-pin-input').value = '';
    document.getElementById('confirm-pin-input').value = '';
    document.getElementById('user-badge').textContent = data.users[newPin].name + (data.users[newPin].isCommissioner ? ' ⭐' : '');

    alert(`Your PIN is now: ${newPin}\n\nRemember it — Ford will not know this PIN.`);
  } catch (err) {
    console.error(err);
    if (msg) { msg.textContent = 'Error changing PIN: ' + (err.message || err); msg.className = 'text-sm mt-2 text-red-400'; }
  }
}



// ---------- Champions ----------
async function loadChampions() {
  try {
    const { data: rows, error } = await window.supabaseClient.from('champions').select('*');
    if (error) {
      console.error('Champions load error:', error);
      data.champions = {};
      data.championsList = [];
      return;
    }
    data.champions = {};
    data.championsList = rows || [];

    const shortLabels = {
      'AEW World Championship': 'World',
      "AEW Women's World Championship": "Women's",
      'AEW TBS Championship': 'TBS',
      'AEW TNT Championship': 'TNT',
      'AEW International Championship': 'Intl',
      'AEW Continental Championship': 'Cont',
      'AEW National Championship': 'Nat',
      'AEW World Tag Team Championship': 'Tag',
      'AEW World Trios Championship': 'Trios',
      "AEW Women's World Tag Team Championship": "WTag",
      'AEW Women\'s World Tag Team Championship': 'WTag'
    };

    (rows || []).forEach(r => {
      if (!r.wrestler || !r.wrestler.trim()) return;
      const label = shortLabels[r.title] || 'Champ';
      r.wrestler.split(',').map(n => n.trim()).filter(Boolean).forEach(name => {
        data.champions[name.toLowerCase()] = label;
      });
    });
    console.log('Champions loaded:', data.champions);
  } catch (e) {
    console.error('Champions exception:', e);
    data.champions = {};
    data.championsList = [];
  }
}

function isChampion(name) {
  return !!(data.champions && data.champions[name.toLowerCase().trim()]);
}
function championLabel(name) {
  return (data.champions && data.champions[name.toLowerCase().trim()]) || null;
}

function renderChampionsEditor() {
  const el = document.getElementById('champions-editor');
  if (!el) return;
  const list = data.championsList || [];
  if (list.length === 0) {
    el.innerHTML = '<p class="text-gray-500 text-sm">No titles loaded. Run the champions SQL first.</p>';
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="flex items-center gap-3">
      <span class="text-sm text-gray-400 w-48 shrink-0">${c.title}</span>
      <input type="text" data-title="${c.title}" value="${c.wrestler || ''}" 
             class="flex-1 bg-black border border-gray-700 rounded-lg px-3 py-1.5 text-sm champion-input"
             placeholder="Champion name" />
    </div>
  `).join('');
}

async function saveChampions() {
  const inputs = document.querySelectorAll('.champion-input');
  const msg = document.getElementById('champions-msg');
  try {
    for (const input of inputs) {
      const title = input.dataset.title;
      const wrestler = input.value.trim();
      await window.supabaseClient.from('champions')
        .update({ wrestler, updated_at: new Date().toISOString() })
        .eq('title', title);
    }
    await loadChampions();
  await loadWrestlerPoints();
  await updateDraftScheduleBanner();
  // pending alerts checked in enterApp
    if (msg) { msg.textContent = 'Champions saved'; msg.className = 'text-sm mt-2 text-emerald-400'; }
    // Re-render any open views
    if (currentUser) {
      renderMyTeam();
      renderLeagueRosters();
    }
  } catch (err) {
    if (msg) { msg.textContent = 'Error: ' + err.message; msg.className = 'text-sm mt-2 text-red-400'; }
  }
}



function renderWaiverFOStatus() {
  const el = document.getElementById('fo-waiver-status');
  if (!el || !currentUser) return;

  const held = data.foreignObjects?.[currentUser] || [];
  const disrupter = held.find(fo => fo.id === 'waiver_disrupter');
  const waiverBank = held.find(fo => fo.id === 'waiver_bank');

  if (!disrupter && !waiverBank) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  let html = '';

  if (disrupter) {
    html += `
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div class="font-semibold text-aew-gold text-sm">You hold: Waiver Disrupter</div>
          <div class="text-xs text-gray-400">Cash in before the deadline to force every other player in your division to fail their first claim.</div>
        </div>
        <button id="activate-disrupter-btn" class="bg-aew-gold text-black font-bold text-sm px-4 py-2 rounded-lg whitespace-nowrap">
          Activate Disrupter
        </button>
      </div>`;
  }
  if (waiverBank) {
    html += `
      <div class="mt-2 text-sm text-gray-300">
        You also hold <span class="text-aew-gold font-semibold">Waiver In The Bank</span> (can drop + add outside normal waiver periods).
      </div>`;
  }
  el.innerHTML = html;

  document.getElementById('activate-disrupter-btn')?.addEventListener('click', activateWaiverDisrupter);
}

async function activateWaiverDisrupter() {
  if (!confirm('Activate Waiver Disrupter? Every other player in your division will fail their first waiver claim this period.')) return;

  const pin = currentUser;
  const list = data.foreignObjects?.[pin] || [];
  const idx = list.findIndex(fo => fo.id === 'waiver_disrupter');
  if (idx === -1) return alert('You do not hold a Waiver Disrupter');

  // Remove FO from this player
  const foRow = list[idx];
  // Delete from DB - find by pin + type
  await window.supabaseClient.from('foreign_objects')
    .delete()
    .eq('pin', pin)
    .eq('fo_type', 'waiver_disrupter');

  list.splice(idx, 1);
  if (list.length === 0) delete data.foreignObjects[pin];
  else data.foreignObjects[pin] = list;

  // Set a flag in settings so processWaivers knows
  const div = data.users[pin]?.division;
  await window.supabaseClient.from('settings').upsert({
    key: 'waiver_disrupter_' + div,
    value: pin  // who activated it
  });

  alert('Waiver Disrupter activated for the ' + (div || '').toUpperCase() + ' division. Other players will fail their first claim.');
  renderWaiverFOStatus();
}



// ---------- Award / manage Foreign Objects (Commissioner) ----------
async function awardForeignObject() {
  const pin = document.getElementById('fo-award-player')?.value;
  const type = document.getElementById('fo-award-type')?.value;
  if (!pin || !type) return alert('Select a player and a Foreign Object');

  const { error } = await window.supabaseClient.from('foreign_objects').insert({
    pin,
    fo_type: type,
    banked: FO_TYPES[type]?.bankable !== false,
    awarded_at: new Date().toISOString()
  });
  if (error) return alert('Error awarding FO: ' + error.message);

  // Refresh local data
  if (!data.foreignObjects[pin]) data.foreignObjects[pin] = [];
  data.foreignObjects[pin].push({
    id: type,
    name: FO_TYPES[type]?.name || type,
    banked: FO_TYPES[type]?.bankable !== false,
    awardedAt: new Date().toISOString()
  });

  renderForeignObjects();
  renderScoreInputs();
  renderWaiverReports();
  const scoreEvent = document.getElementById('score-event');
  if (scoreEvent && scoreEvent.options.length <= 1) {
    const events = ['Dynamite', 'Collision', 'Rampage', 'PPV / Special', 'Foreign Object', 'Other'];
    events.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      scoreEvent.appendChild(opt);
    });
  }
  alert(`Awarded ${FO_TYPES[type]?.name || type} to ${data.users[pin]?.name || pin}`);
}

function renderForeignObjects() {
  // Populate player selects
  const players = Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .map(([pin, u]) => ({ pin, name: u.name, division: u.division }));

  ['fo-award-player', 'fo-activate-player'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Select player...</option>' +
      players.map(p => `<option value="${p.pin}">${p.name} (${p.division})</option>`).join('');
    if (current) sel.value = current;
  });

  // Currently held list
  const heldEl = document.getElementById('fo-held-list');
  if (heldEl) {
    const entries = [];
    Object.entries(data.foreignObjects || {}).forEach(([pin, list]) => {
      const u = data.users[pin];
      if (!u) return;
      (list || []).forEach(fo => {
        entries.push(`<div class="flex justify-between gap-2 text-sm">
          <span>${u.name}</span>
          <span class="text-aew-gold">${fo.name || fo.id}${fo.banked ? ' (banked)' : ''}</span>
        </div>`);
      });
    });
    heldEl.innerHTML = entries.length ? entries.join('') : '<p class="text-gray-500 text-sm">None awarded yet</p>';
  }
}

// Wire into commissioner render
const _origRenderCommFO = typeof renderCommissioner === 'function' ? renderCommissioner : null;



// ---------- Draft Room ----------
const DRAFT_ROUNDS = 8;

async function loadDraftState(division) {
  const { data: draft } = await window.supabaseClient.from('drafts').select('*').eq('division', division).maybeSingle();
  const { data: picks } = await window.supabaseClient.from('draft_picks').select('*').eq('division', division).order('pick_number');
  return { draft: draft || null, picks: picks || [] };
}

async function loadAutopick(pin) {
  const { data } = await window.supabaseClient.from('draft_autopicks').select('ranked').eq('pin', pin).maybeSingle();
  return data?.ranked || [];
}

async function saveAutopickList() {
  const text = document.getElementById('autopick-list')?.value || '';
  const ranked = text.split('\n').map(l => l.trim()).filter(Boolean);
  const { error } = await window.supabaseClient.from('draft_autopicks').upsert({
    pin: currentUser,
    ranked,
    updated_at: new Date().toISOString()
  });
  const msg = document.getElementById('autopick-msg');
  if (error) {
    if (msg) { msg.textContent = 'Error: ' + error.message; msg.className = 'text-sm mt-2 text-red-400'; }
  } else {
    if (msg) { msg.textContent = 'Autopick list saved (' + ranked.length + ' names)'; msg.className = 'text-sm mt-2 text-emerald-400'; }
  }
}

function getSnakePin(order, pickIndex) {
  // pickIndex is 0-based overall pick
  const n = order.length;
  if (n === 0) return null;
  const round = Math.floor(pickIndex / n); // 0-based round
  const pos = pickIndex % n;
  if (round % 2 === 0) {
    return order[pos]; // forward
  } else {
    return order[n - 1 - pos]; // reverse
  }
}

async function generateDraftOrder(division) {
  const pins = Object.entries(data.users)
    .filter(([_, u]) => u.division === division)
    .map(([pin]) => pin);
  // Fisher-Yates shuffle
  for (let i = pins.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pins[i], pins[j]] = [pins[j], pins[i]];
  }
  await window.supabaseClient.from('drafts').upsert({
    division,
    order_pins: pins,
    current_pick: 0,
    status: 'idle',
    updated_at: new Date().toISOString()
  });
  renderDraft();
  alert(division.toUpperCase() + ' order: ' + pins.map(p => data.users[p]?.name || p).join(' → '));
}

async function startDraft(division) {
  const { data: draft } = await window.supabaseClient.from('drafts').select('*').eq('division', division).maybeSingle();
  if (!draft?.order_pins?.length) return alert('Generate a random order first');
  // Clear old picks
  await window.supabaseClient.from('draft_picks').delete().eq('division', division);
  await window.supabaseClient.from('drafts').update({
    status: 'active',
    current_pick: 0,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('division', division);
  renderDraft();
}

async function setDraftStatus(division, status) {
  await window.supabaseClient.from('drafts').update({
    status,
    updated_at: new Date().toISOString()
  }).eq('division', division);
  renderDraft();
}

async function makeDraftPick(division, wrestler, isAuto = false) {
  const { draft, picks } = await loadDraftState(division);
  if (!draft || draft.status !== 'active') return alert('Draft is not active');

  const order = draft.order_pins || [];
  const pickIndex = draft.current_pick || 0;
  const totalPicks = order.length * DRAFT_ROUNDS;
  if (pickIndex >= totalPicks) return alert('Draft is complete');

  const pin = getSnakePin(order, pickIndex);
  const round = Math.floor(pickIndex / order.length) + 1;
  const pickNumber = pickIndex + 1;

  // Already taken in this division?
  const taken = new Set((picks || []).map(p => (p.wrestler || '').toLowerCase()));
  if (taken.has(wrestler.toLowerCase())) return alert('Already drafted in this division');

  await window.supabaseClient.from('draft_picks').insert({
    division,
    pick_number: pickNumber,
    round,
    pin,
    wrestler,
    is_auto: isAuto
  });

  const nextPick = pickIndex + 1;
  const done = nextPick >= totalPicks;
  await window.supabaseClient.from('drafts').update({
    current_pick: nextPick,
    status: done ? 'complete' : 'active',
    updated_at: new Date().toISOString()
  }).eq('division', division);

  // If complete, write final rosters
  if (done) {
    await finalizeDraftRosters(division);
  }

  renderDraft();
}

async function finalizeDraftRosters(division) {
  const { picks } = await loadDraftState(division);
  const byPin = {};
  (picks || []).forEach(p => {
    if (!p.wrestler) return;
    if (!byPin[p.pin]) byPin[p.pin] = [];
    byPin[p.pin].push(p.wrestler);
  });
  for (const [pin, roster] of Object.entries(byPin)) {
    await saveTeamRoster(pin, roster, 8);
  }
  alert(division.toUpperCase() + ' draft complete. Rosters updated.');
}

async function tryAutopick(division) {
  const { draft, picks } = await loadDraftState(division);
  if (!draft || draft.status !== 'active') return;
  const order = draft.order_pins || [];
  const pickIndex = draft.current_pick || 0;
  const pin = getSnakePin(order, pickIndex);
  if (!pin) return;

  const ranked = await loadAutopick(pin);
  const taken = new Set((picks || []).map(p => (p.wrestler || '').toLowerCase()));
  // Also exclude anyone already on any roster in this division from previous season? For new draft we only care about picks so far
  const available = data.masterRoster.filter(w => !taken.has(w.toLowerCase()));

  for (const name of ranked) {
    const match = available.find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      await makeDraftPick(division, match, true);
      return;
    }
  }
  // Fallback: first available alphabetically
  if (available.length) {
    await makeDraftPick(division, available[0], true);
  }
}

async function renderDraft() {
  const statusEl = document.getElementById('draft-status-bar');
  const boardEl = document.getElementById('draft-board');
  const pickArea = document.getElementById('draft-pick-area');
  const commishBox = document.getElementById('draft-commish-controls');
  if (!statusEl) return;

  const isCommish = data.users[currentUser]?.isCommissioner;
  if (commishBox) {
    if (isCommish) commishBox.classList.remove('hidden');
    else commishBox.classList.add('hidden');
  }

  // Load both divisions summary
  const east = await loadDraftState('east');
  const west = await loadDraftState('west');

  const myDiv = data.users[currentUser]?.division;
  const focusDiv = isCommish ? (document.getElementById('draft-div-select')?.value || 'east') : myDiv;
  const focus = focusDiv === 'west' ? west : east;

  // Status bar
  const d = focus.draft;
  if (!d) {
    statusEl.innerHTML = '<p class="text-gray-500 text-sm">No draft data. Commissioner needs to set up the draft.</p>';
  } else {
    const orderNames = (d.order_pins || []).map(p => data.users[p]?.name || p).join(' → ');
    statusEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span class="font-bold">${(focusDiv || '').toUpperCase()} Draft</span>
          <span class="ml-2 text-sm px-2 py-0.5 rounded ${d.status === 'active' ? 'bg-emerald-900 text-emerald-300' : d.status === 'complete' ? 'bg-blue-900 text-blue-300' : 'bg-gray-800 text-gray-400'}">${d.status}</span>
        </div>
        <div class="text-sm text-gray-400">Pick ${(d.current_pick || 0) + 1} of ${((d.order_pins || []).length * DRAFT_ROUNDS) || '?'}</div>
      </div>
      ${d.scheduled_at ? `<div class="text-sm text-blue-300 mt-2">Scheduled: ${new Date(d.scheduled_at).toLocaleString()}</div>` : ''}
      ${orderNames ? `<div class="text-xs text-gray-500 mt-1">Order: ${orderNames}</div>` : ''}
    `;
  }

  // Order display for commish
  const orderDisp = document.getElementById('draft-order-display');
  if (orderDisp && d?.order_pins) {
    orderDisp.textContent = 'Current order: ' + d.order_pins.map(p => data.users[p]?.name || p).join(' → ');
  }

  // On the clock
  if (pickArea) {
    if (d?.status === 'active' && d.order_pins?.length) {
      const pin = getSnakePin(d.order_pins, d.current_pick || 0);
      const name = data.users[pin]?.name || pin;
      const isMyTurn = pin === currentUser;
      const taken = new Set((focus.picks || []).map(p => (p.wrestler || '').toLowerCase()));
      const available = data.masterRoster.filter(w => !taken.has(w.toLowerCase())).sort((a,b) => a.localeCompare(b));

      pickArea.innerHTML = `
        <div class="text-center mb-4">
          <div class="text-sm text-gray-400">On the clock</div>
          <div class="text-2xl font-bold ${isMyTurn ? 'text-aew-gold' : ''}">${name}${isMyTurn ? ' (you)' : ''}</div>
        </div>
        ${isMyTurn || isCommish ? `
          <div class="max-h-48 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-1 mb-3">
            ${available.slice(0, 120).map(w => `
              <button class="draft-pick-btn text-left text-sm px-2 py-1.5 rounded bg-black/50 hover:bg-gray-800 border border-gray-800" data-name="${w}">${w}</button>
            `).join('')}
          </div>
          ${isCommish && !isMyTurn ? `<button id="draft-autopick-btn" class="w-full bg-gray-700 hover:bg-gray-600 py-2 rounded-lg text-sm">Force Autopick for ${name}</button>` : ''}
        ` : `<p class="text-center text-gray-500 text-sm">Waiting for ${name} to pick...</p>`}
      `;

      pickArea.querySelectorAll('.draft-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (confirm('Draft ' + btn.dataset.name + '?')) {
            makeDraftPick(focusDiv, btn.dataset.name, false);
          }
        });
      });
      document.getElementById('draft-autopick-btn')?.addEventListener('click', () => tryAutopick(focusDiv));
    } else if (d?.status === 'complete') {
      pickArea.innerHTML = '<div class="text-center text-emerald-400 py-4 font-semibold">Draft complete</div>';
    } else {
      pickArea.innerHTML = '<div class="text-center text-gray-500 py-6">No draft active</div>';
    }
  }

  // Board
  if (boardEl) {
    const picks = focus.picks || [];
    if (!picks.length) {
      boardEl.innerHTML = '<p class="text-gray-500">No picks yet</p>';
    } else {
      boardEl.innerHTML = picks.map(p => `
        <div class="flex gap-3 items-center bg-black/40 rounded-lg px-3 py-2">
          <span class="text-gray-500 w-8">#${p.pick_number}</span>
          <span class="text-gray-400 w-16">R${p.round}</span>
          <span class="font-medium w-24">${data.users[p.pin]?.name || p.pin}</span>
          <span class="${p.is_auto ? 'text-gray-400 italic' : 'text-white'}">${p.wrestler || '—'}${p.is_auto ? ' (auto)' : ''}</span>
        </div>
      `).join('');
    }
  }

  // Load user's autopick into textarea
  const ta = document.getElementById('autopick-list');
  if (ta && currentUser) {
    const ranked = await loadAutopick(currentUser);
    if (!ta.value) ta.value = ranked.join('\n');
  }
  await renderAllAutopicks();
}



async function setDraftSchedule() {
  const div = document.getElementById('draft-div-select')?.value || 'east';
  const date = document.getElementById('draft-schedule-date')?.value;
  const time = document.getElementById('draft-schedule-time')?.value;
  if (!date || !time) return alert('Pick a date and time');
  const when = new Date(`${date}T${time}`);
  if (isNaN(when.getTime())) return alert('Invalid date/time');

  await window.supabaseClient.from('drafts').upsert({
    division: div,
    scheduled_at: when.toISOString(),
    updated_at: new Date().toISOString()
  });
  alert(`${div.toUpperCase()} draft scheduled for ${when.toLocaleString()}`);
  updateDraftScheduleBanner();
  renderDraft();
}

async function updateDraftScheduleBanner() {
  const banner = document.getElementById('draft-schedule-banner');
  const text = document.getElementById('draft-schedule-text');
  if (!banner || !text) return;

  const { data: rows } = await window.supabaseClient.from('drafts').select('division, scheduled_at, status').not('scheduled_at', 'is', null);
  const upcoming = (rows || []).filter(r => r.scheduled_at && r.status !== 'complete');
  if (!upcoming.length) {
    banner.classList.add('hidden');
    return;
  }

  const parts = upcoming.map(r => {
    const when = new Date(r.scheduled_at);
    return `${r.division.toUpperCase()}: ${when.toLocaleString()}`;
  });
  text.textContent = parts.join('  •  ');
  banner.classList.remove('hidden');
}



async function loadWrestlerPoints() {
  try {
    const { data: rows, error } = await window.supabaseClient.from('wrestler_points').select('name, points');
    if (error) {
      console.error('Wrestler points load error:', error);
      data.wrestlerPoints = {};
      return;
    }
    data.wrestlerPoints = {};
    (rows || []).forEach(r => {
      data.wrestlerPoints[r.name.toLowerCase().trim()] = r.points || 0;
    });
    console.log('Wrestler points loaded:', Object.keys(data.wrestlerPoints).length);
  } catch (e) {
    console.error(e);
    data.wrestlerPoints = {};
  }
}

function getWrestlerPts(name) {
  if (!data.wrestlerPoints) return 0;
  return data.wrestlerPoints[name.toLowerCase().trim()] ?? 0;
}

async function saveWrestlerPointsBulk(updates) {
  // updates = [{name, points}, ...]
  for (const u of updates) {
    await window.supabaseClient.from('wrestler_points').upsert({
      name: u.name,
      points: u.points,
      updated_at: new Date().toISOString()
    });
    data.wrestlerPoints[u.name.toLowerCase().trim()] = u.points;
  }
}



async function renderAllAutopicks() {
  const el = document.getElementById('draft-autopick-viewer');
  if (!el) return;
  if (!data.users[currentUser]?.isCommissioner) {
    el.innerHTML = '';
    return;
  }
  const { data: rows } = await window.supabaseClient.from('draft_autopicks').select('pin, ranked, updated_at');
  if (!rows || !rows.length) {
    el.innerHTML = '<p class="text-gray-500">No autopick lists submitted yet</p>';
    return;
  }
  el.innerHTML = rows.map(r => {
    const name = data.users[r.pin]?.name || r.pin;
    const list = (r.ranked || []).join(', ') || '(empty)';
    const when = r.updated_at ? new Date(r.updated_at).toLocaleString() : '';
    return `<div class="bg-black/40 rounded-lg px-3 py-2">
      <div class="font-medium">${name} <span class="text-xs text-gray-500">${when}</span></div>
      <div class="text-xs text-gray-400 mt-1">${list}</div>
    </div>`;
  }).join('');
}



// ---------- RED ALERT Broadcasts ----------
let pendingBroadcasts = [];
let currentAlertId = null;

async function loadPendingBroadcasts() {
  if (!currentUser) return;
  try {
    // Get all broadcasts targeted at this user or 'all'
    const { data: broadcasts } = await window.supabaseClient
      .from('broadcasts')
      .select('*')
      .or(`target.eq.all,target.eq.${currentUser}`)
      .order('created_at', { ascending: true });

    if (!broadcasts || !broadcasts.length) {
      pendingBroadcasts = [];
      return;
    }

    // Get acks for this user
    const { data: acks } = await window.supabaseClient
      .from('broadcast_acks')
      .select('broadcast_id')
      .eq('pin', currentUser);

    const ackedIds = new Set((acks || []).map(a => a.broadcast_id));
    pendingBroadcasts = broadcasts.filter(b => !ackedIds.has(b.id));
    showNextAlert();
  } catch (e) {
    console.error('Broadcast load error:', e);
  }
}

function showNextAlert() {
  const modal = document.getElementById('red-alert-modal');
  const msgEl = document.getElementById('red-alert-message');
  if (!modal || !msgEl) return;

  if (!pendingBroadcasts.length) {
    modal.classList.add('hidden');
    currentAlertId = null;
    return;
  }

  const alert = pendingBroadcasts[0];
  currentAlertId = alert.id;
  msgEl.textContent = alert.message;
  modal.classList.remove('hidden');
}

async function ackCurrentAlert() {
  if (!currentAlertId || !currentUser) return;
  await window.supabaseClient.from('broadcast_acks').upsert({
    broadcast_id: currentAlertId,
    pin: currentUser,
    acked_at: new Date().toISOString()
  });
  pendingBroadcasts = pendingBroadcasts.filter(b => b.id !== currentAlertId);
  currentAlertId = null;
  showNextAlert();
}

async function sendBroadcast() {
  const target = document.getElementById('broadcast-target')?.value || 'all';
  const message = (document.getElementById('broadcast-message')?.value || '').trim();
  const status = document.getElementById('broadcast-status');
  if (!message) {
    if (status) { status.textContent = 'Enter a message'; status.className = 'text-sm mt-3 text-red-400'; }
    return;
  }

  const { error } = await window.supabaseClient.from('broadcasts').insert({
    from_pin: currentUser,
    target,
    message
  });

  if (error) {
    if (status) { status.textContent = 'Error: ' + error.message; status.className = 'text-sm mt-3 text-red-400'; }
    return;
  }

  document.getElementById('broadcast-message').value = '';
  if (status) { status.textContent = 'RED ALERT sent!'; status.className = 'text-sm mt-3 text-emerald-400'; }
  renderBroadcastHistory();
}

async function renderBroadcastHistory() {
  const el = document.getElementById('broadcast-history');
  if (!el) return;
  const { data: rows } = await window.supabaseClient
    .from('broadcasts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (!rows || !rows.length) {
    el.innerHTML = '<p>None yet</p>';
    return;
  }
  el.innerHTML = rows.map(b => {
    const targetName = b.target === 'all' ? 'Everyone' : (data.users[b.target]?.name || b.target);
    const when = new Date(b.created_at).toLocaleString();
    return `<div class="bg-black/40 rounded-lg px-3 py-2 border border-gray-800">
      <div class="flex justify-between gap-2 text-xs text-gray-500 mb-1">
        <span>To: <span class="text-gray-300">${targetName}</span></span>
        <span>${when}</span>
      </div>
      <div class="text-gray-200">${b.message}</div>
    </div>`;
  }).join('');
}

function renderBroadcastTab() {
  // Populate target select
  const sel = document.getElementById('broadcast-target');
  if (sel) {
    const players = Object.entries(data.users)
      .filter(([_, u]) => u.division)
      .map(([pin, u]) => ({ pin, name: u.name, division: u.division }));
    sel.innerHTML = '<option value="all">Everyone</option>' +
      players.map(p => `<option value="${p.pin}">${p.name} (${p.division})</option>`).join('');
  }
  renderBroadcastHistory();
}



async function softRefresh(showToast = false) {
  if (!currentUser) return;
  try {
    await loadAllData();
    // Re-render the current visible tab
    const active = document.querySelector('.nav-btn.active');
    const tab = active?.dataset?.tab || 'standings';
    if (tab === 'standings') renderStandings();
    else if (tab === 'myteam') renderMyTeam();
    else if (tab === 'transactions') { renderWaiver(); }
    else if (tab === 'draft') renderDraft();
    else if (tab === 'broadcast') renderBroadcastTab();
    else if (tab === 'commissioner') renderCommissioner();
    else if (tab === 'rules') renderScoringTable();

    await loadPendingBroadcasts();
    await updateDraftScheduleBanner();
    updateTradeBanner();

    if (showToast) {
      const badge = document.getElementById('user-badge');
      if (badge) {
        const old = badge.textContent;
        badge.textContent = 'Updated ✓';
        setTimeout(() => { badge.textContent = old; }, 1500);
      }
    }
  } catch (e) {
    console.error('softRefresh error:', e);
  }
}

// Auto-refresh every 30 seconds while logged in
setInterval(() => {
  if (currentUser && !document.hidden) softRefresh(false);
}, 30000);

// Refresh when tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) softRefresh(false);
});



// ---------- Team Score Entry (Commissioner) ----------
function renderScoreInputs() {
  const el = document.getElementById('score-inputs');
  if (!el) return;

  const teams = Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .sort((a, b) => {
      if (a[1].division !== b[1].division) return a[1].division.localeCompare(b[1].division);
      return a[1].name.localeCompare(b[1].name);
    });

  el.innerHTML = teams.map(([pin, u]) => `
    <div class="flex items-center gap-2">
      <span class="text-xs text-gray-500 w-12">${u.division === 'east' ? 'EAST' : 'WEST'}</span>
      <span class="text-sm w-24 font-medium">${u.name}</span>
      <span class="text-xs text-gray-500 w-16">${data.points[pin] || 0} pts</span>
      <input type="number" data-pin="${pin}" class="score-add-input w-20 bg-black border border-gray-700 rounded-lg px-2 py-1.5 text-sm" placeholder="+pts" />
    </div>
  `).join('');
}

async function saveScores() {
  const inputs = document.querySelectorAll('.score-add-input');
  const eventName = document.getElementById('score-event')?.value || 'Show';
  let updated = 0;

  for (const input of inputs) {
    const add = parseInt(input.value, 10);
    if (!add || isNaN(add)) continue;
    const pin = input.dataset.pin;
    const current = data.points[pin] || 0;
    const next = current + add;
    await saveTeamPoints(pin, next);
    input.value = '';
    updated++;
  }

  if (updated === 0) {
    alert('Enter points to add for at least one team (use the +pts boxes).');
    return;
  }

  renderScoreInputs();
  renderWaiverReports();
  const scoreEvent = document.getElementById('score-event');
  if (scoreEvent && scoreEvent.options.length <= 1) {
    const events = ['Dynamite', 'Collision', 'Rampage', 'PPV / Special', 'Foreign Object', 'Other'];
    events.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      scoreEvent.appendChild(opt);
    });
  }
  renderStandings();
  alert(`Saved points for ${updated} team(s). Standings updated.`);
}

// Also allow setting absolute total (optional helper)
async function setAbsoluteTeamPoints(pin, total) {
  await saveTeamPoints(pin, total);
  renderScoreInputs();
  renderWaiverReports();
  const scoreEvent = document.getElementById('score-event');
  if (scoreEvent && scoreEvent.options.length <= 1) {
    const events = ['Dynamite', 'Collision', 'Rampage', 'PPV / Special', 'Foreign Object', 'Other'];
    events.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      scoreEvent.appendChild(opt);
    });
  }
  renderStandings();
}



function updateWaiverDeadlineBanner() {
  const banner = document.getElementById('waiver-deadline-banner');
  const text = document.getElementById('waiver-deadline-banner-text');
  if (!banner || !text) return;

  if (!data.waiverDeadline) {
    banner.classList.add('hidden');
    text.textContent = '';
    return;
  }

  const deadline = new Date(data.waiverDeadline);
  if (isNaN(deadline.getTime())) {
    banner.classList.add('hidden');
    return;
  }

  const now = new Date();
  const when = deadline.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

  if (now >= deadline) {
    text.textContent = 'Waiver deadline has passed (' + when + '). Claims are locked / processing.';
  } else {
    text.textContent = 'Waiver claims due by ' + when + '. Submit before this time.';
  }
  banner.classList.remove('hidden');
}


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
  document.getElementById('refresh-btn')?.addEventListener('click', () => softRefresh(true));
  document.getElementById('save-scores')?.addEventListener('click', saveScores);
  document.getElementById('change-pin-btn')?.addEventListener('click', changePin);
  document.getElementById('save-champions')?.addEventListener('click', saveChampions);
  document.getElementById('fo-award-btn')?.addEventListener('click', awardForeignObject);
  document.getElementById('wp-save-btn')?.addEventListener('click', async () => {
    const name = (document.getElementById('wp-name')?.value || '').trim();
    const pts = parseInt(document.getElementById('wp-points')?.value, 10);
    const msg = document.getElementById('wp-msg');
    if (!name || isNaN(pts)) {
      if (msg) { msg.textContent = 'Enter name and points'; msg.className = 'text-sm text-red-400'; }
      return;
    }
    await saveWrestlerPointsBulk([{ name, points: pts }]);
    if (msg) { msg.textContent = `Updated ${name} to ${pts} pts`; msg.className = 'text-sm text-emerald-400'; }
    document.getElementById('wp-name').value = '';
    document.getElementById('wp-points').value = '';
  });

  document.getElementById('wp-bulk-btn')?.addEventListener('click', async () => {
    const text = document.getElementById('wp-bulk')?.value || '';
    const updates = [];
    text.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      const parts = line.rsplit ? line.rsplit(' ', 1) : null;
      // simple: last token is points
      const m = line.match(/^(.+)\s+(-?\d+)$/);
      if (m) updates.push({ name: m[1].trim(), points: parseInt(m[2], 10) });
    });
    if (!updates.length) return alert('No valid lines (format: Name 12)');
    await saveWrestlerPointsBulk(updates);
    const msg = document.getElementById('wp-msg');
    if (msg) { msg.textContent = `Updated ${updates.length} wrestlers`; msg.className = 'text-sm text-emerald-400'; }
  });

  document.getElementById('save-autopick')?.addEventListener('click', saveAutopickList);
  document.getElementById('draft-generate-order')?.addEventListener('click', () => {
    const div = document.getElementById('draft-div-select')?.value || 'east';
    generateDraftOrder(div);
  });
  document.getElementById('draft-start')?.addEventListener('click', () => {
    const div = document.getElementById('draft-div-select')?.value || 'east';
    if (confirm('Start ' + div.toUpperCase() + ' draft? This clears any previous picks for that division.')) startDraft(div);
  });
  document.getElementById('draft-pause')?.addEventListener('click', () => {
    const div = document.getElementById('draft-div-select')?.value || 'east';
    setDraftStatus(div, 'paused');
  });
  document.getElementById('draft-resume')?.addEventListener('click', () => {
    const div = document.getElementById('draft-div-select')?.value || 'east';
    setDraftStatus(div, 'active');
  });
  document.getElementById('draft-div-select')?.addEventListener('change', () => renderDraft());
  document.getElementById('draft-set-schedule')?.addEventListener('click', setDraftSchedule);
  document.getElementById('goto-draft-tab')?.addEventListener('click', () => showTab('draft'));
  document.getElementById('broadcast-send')?.addEventListener('click', sendBroadcast);
  document.getElementById('red-alert-ok')?.addEventListener('click', ackCurrentAlert);
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
    const drop = document.getElementById('drop-select')?.value;
    if (!drop) {
      document.getElementById('claim-status').textContent = 'You must select a wrestler to drop';
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-red-400';
      return;
    }
    await saveClaim(currentUser, [...claimRanked], drop);
    document.getElementById('claim-status').textContent = 'Claim submitted successfully (drop: ' + drop + ')';
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
