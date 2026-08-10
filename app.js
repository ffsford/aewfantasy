// =====================================================
// AEW Fantasy League  Season 9
// Client-side prototype with localStorage persistence
// =====================================================

const STORAGE_KEY = 'aew_fantasy_s9_v11';

// ---------- Default / Seed Data ----------
const DEFAULT_DATA = {
  users: {
    // East Coast
    bito: {
      name: 'BITO', division: 'east', isCommissioner: false, maxRoster: 8,
      roster: ['Kevin Knight','Darby Allin','Mike Bailey','Andrade','Brody King','Ricochet','Wheeler Yuta','Austin Creed']
    },
    josh: {
      name: 'JOSH', division: 'east', isCommissioner: false, maxRoster: 8,
      roster: ['Jon Moxley','Kyle Fletcher','Swerve','Persephone','Hikaru Shida','Juice Robinson','Colton Gunn','Austin Gunn']
    },
    lenz: {
      name: 'LENZ', division: 'east', isCommissioner: false, maxRoster: 8,
      roster: ['Mark Davis','Orange Cassidy','Roderick Strong','Adam Copeland','Kris Statlander','Kazuchika Okada','Jamie Hayter','Willow']
    },
    matty: {
      name: 'MATTY', division: 'east', isCommissioner: false, maxRoster: 8,
      roster: ['Matt Jackson','Nick Jackson','Shota Umino','Bandido','Claudio','Thunder Rosa','Rush','Mistico']
    },
    gally: {
      name: 'GALLY', division: 'east', isCommissioner: false, maxRoster: 8,
      roster: ['Konosuke Takeshita','Thekla','Kyle O\'Reilly','Christian Cage','PAC','Hangman Page','Chris Jericho','Mina Shirakawa']
    },
    brian: {
      name: 'BRIAN', division: 'east', isCommissioner: false, maxRoster: 8,
      roster: ['MJF','David Finlay','Daniel Garcia','Megan Bayne','Tommaso Ciampa','Alex Windsor','Maya World','Bishop Kaun']
    },
    evan: {
      name: 'EVAN', division: 'east', isCommissioner: false, maxRoster: 9,
      roster: ['Will Ospreay','Mercedes Mone','Kenny Omega','Lena Kross','Nigel McGuinness','Chris Sabin','Alex Shelley','Jay White','Kofi Kingston']
    },
    // West Coast
    ford: {
      name: 'FORD', division: 'west', isCommissioner: false, maxRoster: 8,
      roster: ['Chris Sabin','Matt Jackson','Andrade','Bandido','Brody King','Tommaso Ciampa','Maya World','Alex Shelley']
    },
    totes: {
      name: 'TOTES', division: 'west', isCommissioner: false, maxRoster: 8,
      roster: ['Konosuke Takeshita','Kyle O\'Reilly','Roderick Strong','Adam Copeland','Hechicero','Chris Jericho','Eddie Kingston','Brian Cage']
    },
    vegas: {
      name: 'VEGAS', division: 'west', isCommissioner: false, maxRoster: 8,
      roster: ['Jon Moxley','MJF','Kazuchika Okada','David Finlay','Ricochet','Mike Bailey','Daniel Garcia','Josh Alexander']
    },
    devin: {
      name: 'DEVIN', division: 'west', isCommissioner: true, maxRoster: 8,
      roster: ['Will Ospreay','Kenny Omega','Nick Jackson','Nigel McGuinness','Dax Harwood','Cash Wheeler','Alex Windsor','Jamie Hayter']
    },
    stess: {
      name: 'STESS', division: 'west', isCommissioner: false, maxRoster: 8,
      roster: ['Kevin Knight','Orange Cassidy','Darby Allin','Clark Connors','Kris Statlander','Jack Perry','Claudio','Wheeler Yuta']
    },
    austin: {
      name: 'AUSTIN', division: 'west', isCommissioner: false, maxRoster: 8,
      roster: ['Mark Davis','Megan Bayne','Lena Kross','Thunder Rosa','PAC','Shota Umino','Mistico','Mascara Dorada']
    },
    cliff: {
      name: 'CLIFF', division: 'west', isCommissioner: false, maxRoster: 8,
      roster: ['Mercedes Mone','Swerve','Kyle Fletcher','Christian Cage','Hangman Page','Thekla','Jay White','Willow']
    }
  },
  points: {
    bito: 202, josh: 197, lenz: 150, matty: 140, gally: 138, brian: 122, evan: 119,
    ford: 199, totes: 183, vegas: 166, devin: 159, stess: 155, austin: 129, cliff: 122
  },
  weekly: {},          // { eventId: { pin: points } }
  masterRoster: [      // Sample  commissioner will replace with full upload
    'Jon Moxley', 'Kenny Omega', 'Will Ospreay', 'Kazuchika Okada', 'Mercedes Mon�',
    'Toni Storm', 'Mariah May', 'Willow Nightingale', 'Swerve Strickland', 'MJF',
    'Darby Allin', 'Hangman Page', 'Bryan Danielson', 'Jack Perry', 'Chris Jericho',
    'Samoa Joe', 'Claudio Castagnoli', 'Wheeler Yuta', 'Konosuke Takeshita', 'Kyle Fletcher',
    'Mark Briscoe', 'Jay White', 'Juice Robinson', 'The Acclaimed', 'Billie Starkz'
  ],
  claims: {},          // { pin: { ranked: [], submittedAt: timestamp } }
  wheelHistory: [],
  coinHistory: [],
  foreignObjects: {
    // pin -> array of { id, name, banked: true/false, awardedAt }
  },
  foHistory: [],
  waiverDeadline: null,
  events: [
    { id: 'forbidden_door', name: 'Forbidden Door', date: '6/28', type: 'ppv' },
    { id: 'beach_break', name: 'Beach Break', date: '7/8', type: 'tv' },
    { id: 'redemption', name: 'Redemption', date: '7/26', type: 'ppv' },
    { id: 'grand_slam_1', name: 'Grand Slam', date: '8/5', type: 'tv' },
    { id: 'grand_slam_2', name: 'Grand Slam', date: '8/5', type: 'tv' },
    { id: 'all_in', name: 'All In', date: '8/30', type: 'ppv' },
    { id: 'rebel_heart', name: 'Rebel Heart', date: '9/9', type: 'tv' },
    { id: 'all_out', name: 'All Out', date: '9/26', type: 'ppv' },
    { id: 'wrestledream', name: 'WrestleDream', date: '10/17', type: 'ppv' },
    { id: 'full_gear', name: 'Full Gear', date: '11/14', type: 'ppv' }
  ]
};

// Scoring table (from your attached sheet)
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

// Wheel of Boom segments (equal probability for now)
const WHEEL_SEGMENTS = [
  { label: '+20 Points', color: '#3b82f6', effect: 'points', value: 20 },
  { label: '+30 Points', color: '#8b5cf6', effect: 'points', value: 30 },
  { label: '+40 Points', color: '#ec4899', effect: 'points', value: 40 },
  { label: '+50 Points', color: '#ef4444', effect: 'points', value: 50 },
  { label: 'Roster → 9', color: '#10b981', effect: 'roster9', value: null },
  { label: 'Steal 5 pts\n(from all)', color: '#f59e0b', effect: 'steal5', value: null }
];

// ---------- State ----------
let data = null;
let currentUser = null; // pin
let claimRanked = [];   // temporary ranked list while building a claim

// ---------- Persistence ----------
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      data = JSON.parse(raw);
      // Ensure new fields exist
      if (!data.masterRoster) data.masterRoster = DEFAULT_DATA.masterRoster;
      if (!data.claims) data.claims = {};
      if (!data.wheelHistory) data.wheelHistory = [];
      if (!data.coinHistory) data.coinHistory = [];
    } catch (e) {
      data = structuredClone(DEFAULT_DATA);
    }
  } else {
    data = structuredClone(DEFAULT_DATA);
  }
  saveData();
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ---------- Auth ----------
function login(pin) {
  pin = pin.trim().toLowerCase();
  if (!pin || pin.length > 10 || !/^[a-z0-9]+$/i.test(pin)) {
    return { ok: false, error: 'PIN must be 1-10 letters or numbers only' };
  }
  if (!data.users[pin]) {
    // Allow new PINs to be created as players later; for now only known
    return { ok: false, error: 'PIN not found. Ask the commissioner to add you.' };
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

// ---------- UI Helpers ----------
function showTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
  
  // Refresh content when switching
  if (tabId === 'standings') renderStandings();
  if (tabId === 'myteam') renderMyTeam();
  if (tabId === 'waiver') renderWaiver();
  if (tabId === 'rules') renderScoringTable();
  if (tabId === 'commissioner') renderCommissioner();
}

function renderStandings() {
  const east = Object.entries(data.users)
    .filter(([pin, u]) => u.division === 'east')
    .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0, maxRoster: u.maxRoster }))
    .sort((a, b) => b.points - a.points);
    
  const west = Object.entries(data.users)
    .filter(([pin, u]) => u.division === 'west')
    .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0, maxRoster: u.maxRoster }))
    .sort((a, b) => b.points - a.points);

  const renderList = (list, containerId) => {
    const el = document.getElementById(containerId);
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
  if (!u || u.isCommissioner) {
    document.getElementById('my-team-content').innerHTML = `
      <div class="text-center py-12 text-gray-500">
        <p>Commissioner view  use the Commissioner tab for tools.</p>
        <p class="text-sm mt-2">You do not have a personal roster.</p>
      </div>`;
    return;
  }
  
  const pts = data.points[currentUser] || 0;
  const roster = u.roster || [];
  
  document.getElementById('my-team-content').innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold">${u.name}</h2>
        <p class="text-gray-400 text-sm">${u.division === 'east' ? 'East Coast' : 'West Coast'} " Roster ${roster.length}/${u.maxRoster}</p>
      </div>
      <div class="text-right">
        <div class="text-3xl font-black text-aew-gold">${pts}</div>
        <div class="text-xs text-gray-500">Total Points</div>
      </div>
    </div>
    
    <div class="bg-aew-card rounded-xl border border-gray-800 p-4">
      <h3 class="font-semibold mb-3">Current Roster</h3>
      ${roster.length === 0 
        ? '<p class="text-gray-500 text-sm">No wrestlers yet. Draft or claim via waiver.</p>'
        : `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${roster.map(w => `<div class="bg-black/50 rounded-lg px-3 py-2 text-sm">${w}</div>`).join('')}
          </div>`
      }
    </div>
  `;
}

function getAvailableWrestlers(division = null) {
  // If no division given, use the current user's division
  if (!division && currentUser && data.users[currentUser]) {
    division = data.users[currentUser].division;
  }
  if (!division) {
    // fallback: show truly unowned (rare)
    const taken = new Set();
    Object.values(data.users).forEach(u => {
      (u.roster || []).forEach(w => taken.add(w));
    });
    return data.masterRoster.filter(w => !taken.has(w)).sort();
  }

  // Only exclude wrestlers who are already on a team IN THIS DIVISION
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
  
  if (available.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm p-4 text-center">No available wrestlers</p>';
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
  
  // Restore existing claim if any
  if (data.claims[currentUser]) {
    claimRanked = [...data.claims[currentUser].ranked];
  }
  renderClaimList();
}

function renderClaimList() {
  const el = document.getElementById('claim-list');
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
      <button class="text-red-400 text-xs remove-claim" data-idx="${i}"></button>
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
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

function renderCommissioner() {
  // Populate event select
  const select = document.getElementById('score-event');
  select.innerHTML = '<option value="">Select show / PPV...</option>' + 
    data.events.map(e => `<option value="${e.id}">${e.name} (${e.date})</option>`).join('');
  
  // Roster count
  document.getElementById('roster-count').textContent = 
    `${data.masterRoster.length} wrestlers currently in the pool`;
  
  // Pre-fill textarea
  document.getElementById('roster-upload').value = data.masterRoster.join('\n');
  
  // Draw wheel
  drawWheel();
}

// ---------- Wheel of Boom ----------
let wheelRotation = 0;
let isSpinning = false;

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
    
    // Label
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
  
  // Center circle
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
  // Land so the pointer (top) hits the chosen segment
  const extraSpins = 5 + Math.random() * 3;
  const targetRotation = extraSpins * 360 + (360 - randomIndex * segAngle - segAngle / 2);
  
  wheelRotation = targetRotation;
  const canvas = document.getElementById('wheel-canvas');
  canvas.style.transform = `rotate(${wheelRotation}deg)`;
  
  setTimeout(() => {
    const result = WHEEL_SEGMENTS[randomIndex];
    const region = document.getElementById('wheel-region').value;
    applyWheelEffect(result, region);
    document.getElementById('wheel-result').innerHTML = 
      `<span class="text-aew-gold">${result.label.replace('\n', ' ')}</span><br><span class="text-sm text-gray-400">${region.toUpperCase()} region</span>`;
    
    data.wheelHistory.push({
      at: new Date().toISOString(),
      region,
      result: result.label,
      effect: result.effect,
      value: result.value
    });
    saveData();
    isSpinning = false;
  }, 4200);
}

function applyWheelEffect(result, region) {
  if (result.effect === 'points') {
    // Apply to a random player in the region or let commissioner choose later.
    // For now just log  commissioner can manually adjust points.
    // (In a full version we would pick the recipient or apply to the FO winner)
  } else if (result.effect === 'roster9') {
    // Commissioner would select which player gets the +1 roster slot
  } else if (result.effect === 'steal5') {
    // Subtract 5 from every other player in the region
  }
  // For the prototype the result is shown and logged.
  // Full application logic can be expanded once we know how the FO winner is chosen.
}

// ---------- Coin Flip ----------
function flipCoin() {
  const a = document.getElementById('coin-team-a').value.trim() || 'Team A';
  const b = document.getElementById('coin-team-b').value.trim() || 'Team B';
  const winner = Math.random() < 0.5 ? a : b;
  document.getElementById('coin-result').innerHTML = 
    `<span class="text-aew-gold">${winner}</span> wins the flip`;
  
  data.coinHistory.push({ at: new Date().toISOString(), a, b, winner });
  saveData();
}

// ---------- Waiver Processing (Commissioner) ----------
function processWaivers() {
  const log = document.getElementById('waiver-log');
  log.innerHTML = '<p class="text-gray-400">Processing...</p>';
  
  const results = [];
  
  ['east', 'west'].forEach(div => {
    // Order: worst to first (lowest points first)
    const order = Object.entries(data.users)
      .filter(([pin, u]) => u.division === div)
      .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0 }))
      .sort((a, b) => a.points - b.points); // worst first
    
    order.forEach(team => {
      const claim = data.claims[team.pin];
      if (!claim || !claim.ranked || claim.ranked.length === 0) return;
      
      for (const wrestler of claim.ranked) {
        // Still available?
        const available = getAvailableWrestlers(div);
        if (available.includes(wrestler)) {
          // Award
          const u = data.users[team.pin];
          if ((u.roster || []).length < u.maxRoster) {
            u.roster = u.roster || [];
            u.roster.push(wrestler);
            results.push(` ${team.name} claimed <strong>${wrestler}</strong>`);
            // Clear their claim after success
            delete data.claims[team.pin];
            break;
          } else {
            results.push(`� ${team.name} wanted ${wrestler} but roster is full (${u.maxRoster})`);
          }
        }
      }
    });
  });
  
  saveData();
  log.innerHTML = results.length 
    ? results.map(r => `<div class="py-1 border-b border-gray-800">${r}</div>`).join('')
    : '<p class="text-gray-500">No successful claims this run.</p>';
  
  // Refresh views
  renderStandings();
  if (document.getElementById('tab-waiver').classList.contains('hidden') === false) {
    renderWaiver();
  }
}

// ---------- Event Listeners ----------
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  
  // Restore session
  const savedPin = localStorage.getItem('aew_current_pin');
  if (savedPin && data.users[savedPin]) {
    currentUser = savedPin;
    enterApp();
  }
  
  // Login
  document.getElementById('login-btn').addEventListener('click', () => {
    const pin = document.getElementById('pin-input').value;
    const res = login(pin);
    if (res.ok) {
      enterApp();
    } else {
      const err = document.getElementById('login-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
    }
  });
  
  document.getElementById('pin-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
  });
  
  // Logout
  document.getElementById('logout-btn').addEventListener('click', logout);
  
  // Tabs
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  
  // Waiver actions
  document.getElementById('clear-claim').addEventListener('click', () => {
    claimRanked = [];
    renderClaimList();
  });
  
  document.getElementById('submit-claim').addEventListener('click', () => {
    if (claimRanked.length === 0) {
      document.getElementById('claim-status').textContent = 'Add at least one wrestler';
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-red-400';
      return;
    }
    data.claims[currentUser] = {
      ranked: [...claimRanked],
      submittedAt: new Date().toISOString()
    };
    saveData();
    document.getElementById('claim-status').textContent = 'Claim submitted successfully';
    document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-emerald-400';
  });
  
  // Commissioner
  document.getElementById('save-roster').addEventListener('click', () => {
    const text = document.getElementById('roster-upload').value;
    data.masterRoster = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    saveData();
    document.getElementById('roster-count').textContent = 
      `${data.masterRoster.length} wrestlers currently in the pool`;
    alert(`Saved ${data.masterRoster.length} wrestlers to the master pool.`);
  });

  // Add single wrestler to master roster
  const addWrestlerBtn = document.getElementById('add-wrestler-btn');
  if (addWrestlerBtn && !addWrestlerBtn._wired) {
    addWrestlerBtn._wired = true;
    addWrestlerBtn.addEventListener('click', () => {
      const input = document.getElementById('add-wrestler-name');
      const msg = document.getElementById('add-wrestler-msg');
      const name = (input.value || '').trim();
      if (!name) {
        if (msg) { msg.textContent = 'Enter a wrestler name'; msg.className = 'text-sm mt-2 text-red-400'; }
        return;
      }
      if (data.masterRoster.some(w => w.toLowerCase() === name.toLowerCase())) {
        if (msg) { msg.textContent = `"${name}" is already in the master pool`; msg.className = 'text-sm mt-2 text-yellow-400'; }
        return;
      }
      data.masterRoster.push(name);
      data.masterRoster.sort((a, b) => a.localeCompare(b));
      saveData();
      input.value = '';
      document.getElementById('roster-upload').value = data.masterRoster.join('\n');
      document.getElementById('roster-count').textContent = 
        `${data.masterRoster.length} wrestlers currently in the pool`;
      if (msg) {
        msg.textContent = `Added "${name}" to the master pool`;
        msg.className = 'text-sm mt-2 text-emerald-400';
        setTimeout(() => { msg.textContent = ''; }, 4000);
      }
    });
  }


  // CSV / TXT file upload for master roster
  const csvInput = document.getElementById('roster-csv');
  if (csvInput) {
    csvInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        // Handle both plain one-name-per-line and simple CSV (take first column)
        const names = text.split(/\r?\n/)
          .map(line => {
            // If it's a CSV, take the first cell
            const first = line.split(',')[0].replace(/^"|"$/g, '').trim();
            return first;
          })
          .filter(name => name.length > 0 && name.toLowerCase() !== 'name' && name.toLowerCase() !== 'wrestler');
        
        document.getElementById('roster-upload').value = names.join('\n');
        data.masterRoster = names;
        saveData();
        document.getElementById('roster-count').textContent = 
          `${data.masterRoster.length} wrestlers currently in the pool`;
        alert(`Loaded ${names.length} wrestlers from file.`);
      };
      reader.readAsText(file);
    });
  }
  
  document.getElementById('spin-wheel').addEventListener('click', spinWheel);
  document.getElementById('flip-coin').addEventListener('click', flipCoin);
  document.getElementById('process-waivers').addEventListener('click', processWaivers);
  
  // Score event change � show inputs
  document.getElementById('score-event').addEventListener('change', (e) => {
    const eventId = e.target.value;
    const container = document.getElementById('score-inputs');
    if (!eventId) {
      container.innerHTML = '';
      return;
    }
    const teams = Object.entries(data.users)
      .filter(([_, u]) => u.division)
      .map(([pin, u]) => ({ pin, name: u.name }));
    
    container.innerHTML = teams.map(t => `
      <div class="flex items-center gap-2">
        <span class="w-20 text-sm truncate">${t.name}</span>
        <input type="number" data-pin="${t.pin}" class="flex-1 bg-black border border-gray-700 rounded px-2 py-1 text-sm" 
               value="${(data.weekly[eventId] && data.weekly[eventId][t.pin]) || 0}" min="0" />
      </div>
    `).join('');
  });
  
  document.getElementById('save-scores').addEventListener('click', () => {
    const eventId = document.getElementById('score-event').value;
    if (!eventId) return alert('Select a show first');
    
    if (!data.weekly[eventId]) data.weekly[eventId] = {};
    
    document.querySelectorAll('#score-inputs input').forEach(input => {
      const pin = input.dataset.pin;
      const val = parseInt(input.value) || 0;
      data.weekly[eventId][pin] = val;
      
      // Recalculate total (simple sum of all weekly for now)
      // In production we would keep a proper running total
      let total = 0;
      Object.values(data.weekly).forEach(week => {
        if (week[pin]) total += week[pin];
      });
      // Keep the seed totals as base for teams that already have points
      if (DEFAULT_DATA.points[pin]) {
        // For prototype: just add the new week on top of the known total
        // Better logic can be refined once full history is imported
      }
      data.points[pin] = (data.points[pin] || 0); // preserve for now
    });
    
    // For this prototype we do not auto-overwrite the known totals
    // so the standings stay accurate while testing. Commissioner can manually adjust later.
    saveData();
    alert('Scores saved for this event (prototype  totals remain as loaded from sheet).');
    renderStandings();
  });
});


// ---------- Foreign Objects ----------
const FO_TYPES = {
  wheel: { name: 'Wheel Of Boom', bankable: false },
  forced_trade: { name: 'Forced Trade', bankable: true },
  waiver_bank: { name: 'Waiver In The Bank', bankable: true },
  ppv_week: { name: 'PPV Week', bankable: true },
  waiver_disrupter: { name: 'Waiver Disrupter', bankable: true }
};

function renderForeignObjects() {
  // Populate player selects
  const players = Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .map(([pin, u]) => ({ pin, name: u.name, division: u.division }));

  ['fo-award-player', 'fo-activate-player'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">Select player...</option>' +
      players.map(p => `<option value="${p.pin}">${p.name} (${p.division})</option>`).join('');
  });

  // Currently held list
  const heldEl = document.getElementById('fo-held-list');
  if (heldEl) {
    const entries = [];
    Object.entries(data.foreignObjects || {}).forEach(([pin, list]) => {
      const u = data.users[pin];
      if (!u) return;
      list.forEach(fo => {
        entries.push(`<div class="flex justify-between gap-2">
          <span>${u.name}</span>
          <span class="text-aew-gold">${FO_TYPES[fo.id]?.name || fo.id}${fo.banked ? ' (banked)' : ''}</span>
        </div>`);
      });
    });
    heldEl.innerHTML = entries.length ? entries.join('') : '<p class="text-gray-500">None awarded yet</p>';
  }
}

function awardForeignObject() {
  const pin = document.getElementById('fo-award-player').value;
  const type = document.getElementById('fo-award-type').value;
  if (!pin || !type) return alert('Select player and FO type');

  if (!data.foreignObjects) data.foreignObjects = {};
  if (!data.foreignObjects[pin]) data.foreignObjects[pin] = [];

  data.foreignObjects[pin].push({
    id: type,
    name: FO_TYPES[type].name,
    banked: FO_TYPES[type].bankable,
    awardedAt: new Date().toISOString()
  });
  saveData();
  renderForeignObjects();
  alert(`Awarded ${FO_TYPES[type].name} to ${data.users[pin].name}`);
}

function activateForeignObject() {
  const pin = document.getElementById('fo-activate-player').value;
  const type = document.getElementById('fo-activate-type').value;
  if (!pin || !type) return alert('Select player and FO');

  const list = data.foreignObjects?.[pin] || [];
  const idx = list.findIndex(fo => fo.id === type);
  if (idx === -1) return alert('That player does not hold this FO');

  const fo = list[idx];
  const logEl = document.getElementById('fo-activate-log');
  let msg = '';

  if (type === 'wheel') {
    // Just note it - commissioner then uses the Wheel of Boom spinner
    msg = `${data.users[pin].name} activated Wheel Of Boom. Use the spinner above.`;
  } else if (type === 'forced_trade') {
    msg = `${data.users[pin].name} activated Forced Trade. Commissioner must execute the random trade manually for now.`;
  } else if (type === 'waiver_bank') {
    msg = `${data.users[pin].name} activated Waiver In The Bank. They may drop + add one wrestler immediately.`;
  } else if (type === 'ppv_week') {
    msg = `${data.users[pin].name} activated PPV Week. Their Dynamite + Collision scores this week will use PPV values.`;
  } else if (type === 'waiver_disrupter') {
    msg = `${data.users[pin].name} activated Waiver Disrupter. All other players in their region fail their first claim this waiver period.`;
  }

  // Remove the FO after activation
  list.splice(idx, 1);
  if (list.length === 0) delete data.foreignObjects[pin];

  data.foHistory = data.foHistory || [];
  data.foHistory.push({
    at: new Date().toISOString(),
    pin,
    name: data.users[pin].name,
    type,
    message: msg
  });
  saveData();
  renderForeignObjects();
  if (logEl) logEl.innerHTML = `<div class="text-emerald-400">${msg}</div>` + logEl.innerHTML;
}

// Wire up when commissioner tab is shown
const origRenderCommissioner = renderCommissioner;
renderCommissioner = function() {
  origRenderCommissioner();
  renderForeignObjects();

  const awardBtn = document.getElementById('fo-award-btn');
  if (awardBtn && !awardBtn._wired) {
    awardBtn._wired = true;
    awardBtn.addEventListener('click', awardForeignObject);
  }
  const actBtn = document.getElementById('fo-activate-btn');
  if (actBtn && !actBtn._wired) {
    actBtn._wired = true;
    actBtn.addEventListener('click', activateForeignObject);
  }

  // Populate activate type when player changes
  const actPlayer = document.getElementById('fo-activate-player');
  if (actPlayer && !actPlayer._wired) {
    actPlayer._wired = true;
    actPlayer.addEventListener('change', () => {
      const pin = actPlayer.value;
      const typeSel = document.getElementById('fo-activate-type');
      const held = data.foreignObjects?.[pin] || [];
      typeSel.innerHTML = '<option value="">Select FO to activate...</option>' +
        held.map(fo => `<option value="${fo.id}">${fo.name}</option>`).join('');
    });
  }
};



// ---------- Waiver Deadline ----------
function setWaiverDeadline() {
  const date = document.getElementById('waiver-date').value;
  const time = document.getElementById('waiver-time').value;
  if (!date || !time) return alert('Pick both a date and time');

  const deadline = new Date(`${date}T${time}`);
  if (isNaN(deadline.getTime())) return alert('Invalid date/time');

  data.waiverDeadline = deadline.toISOString();
  saveData();
  updateDeadlineStatus();
  alert(`Waiver deadline set to ${deadline.toLocaleString()}`);
}

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
    el.innerHTML = `<span class="text-aew-gold font-bold">Deadline passed — claims should process automatically</span><br>
                    <span class="text-xs text-gray-400">Set: ${deadline.toLocaleString()}</span>`;
    // Auto-process if not already done for this deadline
    if (!data.lastProcessedDeadline || data.lastProcessedDeadline !== data.waiverDeadline) {
      console.log('Auto-processing waivers after deadline...');
      processWaivers();
      data.lastProcessedDeadline = data.waiverDeadline;
      saveData();
    }
  } else {
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    el.innerHTML = `<span class="text-emerald-400">Deadline: ${deadline.toLocaleString()}</span><br>
                    <span class="text-xs text-gray-400">Time remaining: ${hours}h ${mins}m</span>`;
  }
}

// Call on commissioner render and also on app load
const _origRenderComm = renderCommissioner;
renderCommissioner = function() {
  _origRenderComm();
  updateDeadlineStatus();

  const btn = document.getElementById('set-waiver-deadline');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', setWaiverDeadline);
  }
};

// Also check on every page load / tab switch
setInterval(() => {
  if (data && data.waiverDeadline) updateDeadlineStatus();
}, 30000); // check every 30s


function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  
  const u = data.users[currentUser];
  document.getElementById('user-badge').textContent = u.name + (u.isCommissioner ? ' P' : '');
  
  if (u.isCommissioner) {
    document.getElementById('commish-nav').classList.remove('hidden');
  } else {
    document.getElementById('commish-nav').classList.add('hidden');
  }
  
  showTab('standings');
}
