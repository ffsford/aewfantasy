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

/**
 * Hard-coded Season 9 scoring engine.
 * Title rows REPLACE a generic win/loss — never stack "Win a match" on top of defend/become/lose title.
 * Bonuses that never double: tag roster bonus, rivalry roster bonus, multi ending, tournament.
 */
const SCORING_BONUSES = {
  // Applied to FANTASY PLAYER (team owner), not the wrestler. NEVER doubled on PPV (same $ on TV and PPV).
  // Tag: X of your wrestlers on the SAME team/side → +X points (X>=2).
  // Rivalry: +2 for EACH pair of your wrestlers on OPPOSITE sides in the match.
  multiPersonEnding: 1, // wrestler who scores the pin/sub in multi-person match
  tournamentOpening: 1,
  tournamentAdditional: 2,
  tournamentFinals: 3,
  rivalryPerOpposingPair: 2
};

/**
 * Tag Team Bonus (player-level).
 * Count how many of this owner's roster wrestlers are on the same side in the match.
 * If 2+ on one side → owner gets +count for that side.
 * Multiple sides possible only in weird bookings; we sum each qualifying side.
 * @param {string[]} roster - owner's wrestler names
 * @param {string[][]} sides - array of teams/sides, each an array of names in the match
 * @returns {{ points: number, breakdown: string[] }}
 */
function computeTagTeamBonus(roster, sides) {
  const rosterSet = new Set((roster || []).map(n => (n || '').toLowerCase().trim()));
  let points = 0;
  const breakdown = [];
  (sides || []).forEach((side, idx) => {
    const mine = (side || []).filter(w => rosterSet.has((w || '').toLowerCase().trim()));
    if (mine.length >= 2) {
      points += mine.length;
      breakdown.push('Tag bonus +' + mine.length + ' (' + mine.join(', ') + ' teaming)');
    }
  });
  return { points, breakdown };
}

/**
 * Rivalry Bonus (player-level).
 * For every pair of the owner's wrestlers who appear on OPPOSITE sides → +2.
 * Example: A,B,C all on roster in A vs B vs C vs D → pairs AB,AC,BC = 3×2 = 6.
 * Example: A&B vs C&D with A,B,C on roster → AC, BC = 2×2 = 4 rivalry (tag separate).
 * @param {string[]} roster
 * @param {string[][]} sides
 */
function computeRivalryBonus(roster, sides) {
  const rosterSet = new Set((roster || []).map(n => (n || '').toLowerCase().trim()));
  const perPair = SCORING_BONUSES.rivalryPerOpposingPair;
  // Map each of my wrestlers in the match to their side index
  const myPlacements = []; // { name, sideIdx }
  (sides || []).forEach((side, sideIdx) => {
    (side || []).forEach(w => {
      const key = (w || '').toLowerCase().trim();
      if (rosterSet.has(key)) myPlacements.push({ name: w, sideIdx });
    });
  });
  let points = 0;
  const breakdown = [];
  for (let i = 0; i < myPlacements.length; i++) {
    for (let j = i + 1; j < myPlacements.length; j++) {
      if (myPlacements[i].sideIdx !== myPlacements[j].sideIdx) {
        points += perPair;
        breakdown.push('Rivalry +' + perPair + ' (' + myPlacements[i].name + ' vs ' + myPlacements[j].name + ')');
      }
    }
  }
  return { points, breakdown };
}

/**
 * Combined player bonuses for one match (tag + rivalry). Never PPV-doubled.
 * @param {string[]} roster - owner roster
 * @param {string[][]} sides - e.g. [['Matt Jackson','Nick Jackson'],['Dante Martin','Darius Martin']]
 */
function computePlayerMatchBonuses(roster, sides) {
  const tag = computeTagTeamBonus(roster, sides);
  const riv = computeRivalryBonus(roster, sides);
  return {
    points: tag.points + riv.points,
    breakdown: [...tag.breakdown, ...riv.breakdown],
    tag: tag.points,
    rivalry: riv.points
  };
}

const TITLE_TIERS = {
  none: null,
  non_aew: 'non-aew',   // ROH, NJPW, etc.
  mid: 'mid',           // TNT, TBS, International, Tag, Continental, National if treated as mid
  world: 'world'        // Men's / Women's World
};

function scoringPts(actionSubstring, isPpv) {
  const row = SCORING.find(r => r.action.toLowerCase().includes(actionSubstring.toLowerCase()));
  if (!row) return 0;
  return isPpv ? row.ppv : row.tv;
}

/**
 * Score one wrestler in one match.
 * @param {object} opts
 * @param {'win'|'lose'|'draw'|'dq_win'} opts.result
 * @param {'none'|'non_aew'|'mid'|'world'} opts.titleTier
 * @param {'none'|'defend'|'new'|'lose_title'} opts.titleOutcome  // lose_title = challenged and lost title match
 * @param {boolean} opts.isPpv
 * @param {boolean} opts.isMultiPerson  // 3+ wrestlers in match
 * @param {boolean} opts.scoredTheFall  // this wrestler got the pin/sub that ended it
 * @param {'none'|'opening'|'additional'|'finals'} opts.tournamentRound
 * @returns {{ total: number, breakdown: string[] }}
 */
function scoreWrestlerInMatch(opts) {
  const {
    result = 'lose',
    titleTier = 'none',
    titleOutcome = 'none',
    isPpv = false,
    isMultiPerson = false,
    scoredTheFall = false,
    tournamentRound = 'none'
  } = opts || {};

  let total = 0;
  const breakdown = [];
  const col = isPpv ? 'ppv' : 'tv';

  // --- Base result / title (mutually exclusive ladder) ---
  if (titleTier !== 'none' && titleOutcome !== 'none') {
    if (titleTier === 'mid') {
      if (titleOutcome === 'defend') {
        const p = isPpv ? 10 : 5;
        total += p; breakdown.push('Defend midcard title ' + p);
      } else if (titleOutcome === 'new') {
        const p = isPpv ? 12 : 6;
        total += p; breakdown.push('New midcard champion ' + p);
      } else if (titleOutcome === 'lose_title') {
        const p = isPpv ? 8 : 4;
        total += p; breakdown.push('Lose midcard title match ' + p);
      }
    } else if (titleTier === 'world') {
      if (titleOutcome === 'defend') {
        const p = isPpv ? 16 : 8;
        total += p; breakdown.push('Defend world title ' + p);
      } else if (titleOutcome === 'new') {
        const p = isPpv ? 18 : 9;
        total += p; breakdown.push('New world champion ' + p);
      } else if (titleOutcome === 'lose_title') {
        const p = isPpv ? 14 : 7;
        total += p; breakdown.push('Lose world title match ' + p);
      }
    } else if (titleTier === 'non_aew') {
      if (titleOutcome === 'defend') {
        const p = isPpv ? 8 : 4;
        total += p; breakdown.push('Defend non-AEW title ' + p);
      } else if (titleOutcome === 'new') {
        const p = isPpv ? 10 : 5;
        total += p; breakdown.push('New non-AEW champion ' + p);
      } else if (titleOutcome === 'lose_title') {
        const p = isPpv ? 6 : 3;
        total += p; breakdown.push('Lose non-AEW title match ' + p);
      }
    }
  } else {
    // Non-title outcome only
    if (result === 'win') {
      const p = isPpv ? 6 : 3;
      total += p; breakdown.push('Win ' + p);
    } else if (result === 'dq_win' || result === 'draw') {
      const p = isPpv ? 4 : 2;
      total += p; breakdown.push((result === 'draw' ? 'Draw' : 'DQ win') + ' ' + p);
    } else {
      const p = isPpv ? 2 : 1;
      total += p; breakdown.push('Lose/NC ' + p);
    }
  }

  // --- Wrestler bonuses (never doubled with the same bonus twice) ---
  if (isMultiPerson && scoredTheFall) {
    total += SCORING_BONUSES.multiPersonEnding;
    breakdown.push('End multi-person match +' + SCORING_BONUSES.multiPersonEnding);
  }

  if (tournamentRound === 'opening') {
    total += SCORING_BONUSES.tournamentOpening;
    breakdown.push('Tournament opening +' + SCORING_BONUSES.tournamentOpening);
  } else if (tournamentRound === 'additional') {
    total += SCORING_BONUSES.tournamentAdditional;
    breakdown.push('Tournament additional +' + SCORING_BONUSES.tournamentAdditional);
  } else if (tournamentRound === 'finals') {
    total += SCORING_BONUSES.tournamentFinals;
    breakdown.push('Tournament finals +' + SCORING_BONUSES.tournamentFinals);
  }

  return { total, breakdown };
}

/** Example: Maya World TBS defend in 4-way TV, she scores the fall → 5+1=6 */
function scoreShowImportExamples() {
  return {
    mayaWorldTbs4way: scoreWrestlerInMatch({
      result: 'win',
      titleTier: 'mid',
      titleOutcome: 'defend',
      isPpv: false,
      isMultiPerson: true,
      scoredTheFall: true
    }),
    moxleyCupSingles: scoreWrestlerInMatch({
      result: 'win',
      titleTier: 'none',
      titleOutcome: 'none',
      isPpv: false,
      isMultiPerson: false,
      scoredTheFall: true,
      tournamentRound: 'opening' // or additional depending on round
    })
  };
}


let data = {
  users: {},
  points: {},
  masterRoster: [],
  claims: {},
  foreignObjects: {},
  waiverDeadline: null
};

// ---------- Wrestler portraits ----------
// Static files in /portraits/ (GitHub Pages) + optional Supabase overrides
const STATIC_PORTRAITS = {
  'ace austin': 'portraits/Ace Austin.png',
  'action andretti': 'portraits/Action Andretti.png',
  'adam page': 'portraits/Adam Page.png',
  'hangman page': 'portraits/Adam Page.png',
  'hangman adam page': 'portraits/Adam Page.png',
  'alex shelley': 'portraits/Alex Shelley.png',
  'andrade': 'portraits/Andrade.png',
  'andrade el idolo': 'portraits/Andrade.png',
};

async function loadPortraits() {
  data.portraits = {};
  try {
    const { data: rows, error } = await window.supabaseClient
      .from('wrestler_portraits')
      .select('name, image_url');
    if (!error && rows) {
      rows.forEach(r => {
        if (r.name && r.image_url) {
          data.portraits[r.name.toLowerCase().trim()] = r.image_url;
        }
      });
    }
  } catch (e) {
    console.warn('wrestler_portraits table not available yet', e);
  }
}

function portraitUrl(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  // 1) DB / uploaded overrides
  if (data.portraits && data.portraits[key]) return data.portraits[key];
  // 2) Hardcoded aliases (Hangman → Adam Page, etc.)
  if (STATIC_PORTRAITS[key]) return STATIC_PORTRAITS[key];
  const soft = key.replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [k, v] of Object.entries(STATIC_PORTRAITS)) {
    if (k.replace(/[^a-z0-9]+/g, ' ').trim() === soft) return v;
  }
  for (const [k, v] of Object.entries(data.portraits || {})) {
    if (k.replace(/[^a-z0-9]+/g, ' ').trim() === soft) return v;
  }
  // 3) Auto: file in /portraits/ named exactly like the wrestler
  //    GitHub Pages: keep spaces in path (browser encodes). Try .png first.
  const clean = name.trim();
  return 'portraits/' + clean + '.png';
}

function portraitHtml(name, sizeClass) {
  const sz = sizeClass || 'h-24 w-24';
  const url = portraitUrl(name);
  const initials = (name || '?').split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase();
  const ph = `<div class="${sz} rounded bg-gray-800 flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0 border border-gray-700">${initials}</div>`;
  if (!url) return ph;
  // Try .png; on fail try .jpg once; then show initials
  const onerr = "if(!this.dataset.tried){this.dataset.tried='1';this.src=this.src.replace(/\\.png$/i,'.jpg');return;} this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.classList.remove('hidden');";
  return `<img src="${url}" alt="" class="${sz} rounded object-cover flex-shrink-0 border border-gray-700 bg-black" onerror="${onerr}" />` +
    `<div class="hidden ${sz} rounded bg-gray-800 flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0 border border-gray-700">${initials}</div>`;
}

function fileToDataUrl(file, maxDim, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (file.size > maxBytes) {
      reject(new Error('Image too large (max ' + Math.round(maxBytes/1024) + ' KB)'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function normalizeImageBasename(filename) {
  return filename.replace(/\\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().toLowerCase();
}

function findRosterNameForBasename(base) {
  const pool = data.masterRoster || [];
  const exact = pool.find(n => n.toLowerCase() === base);
  if (exact) return exact;
  const soft = base.replace(/[^a-z0-9]+/g, ' ').trim();
  return pool.find(n => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === soft) || null;
}

async function savePortraitToDb(name, dataUrl) {
  const { error } = await window.supabaseClient.from('wrestler_portraits').upsert({
    name,
    image_url: dataUrl,
    updated_at: new Date().toISOString()
  }, { onConflict: 'name' });
  if (!error) {
    data.portraits[name.toLowerCase().trim()] = dataUrl;
  }
  return !error;
}


// ---------- Season dates + Calendar ----------
const CAL_TYPES = {
  weekly_tv: 'Weekly TV',
  special_tv: 'Special',
  ppv: 'PPV',
  foreign_object: 'Foreign Object',
  draft: 'Draft',
  other: 'Other'
};

/** Normalize DB / legacy event_type values to canonical keys */
function normalizeEventType(t) {
  const s = String(t || '').toLowerCase().trim();
  if (!s) return 'other';
  if (s === 'ppv' || s.includes('ppv') || s.includes('ple')) return 'ppv';
  if (s === 'special_tv' || s === 'special' || s.startsWith('special')) return 'special_tv';
  if (s === 'weekly_tv' || s === 'weekly' || s.includes('weekly')) return 'weekly_tv';
  if (s === 'foreign_object' || s.includes('foreign')) return 'foreign_object';
  if (s === 'draft') return 'draft';
  return 'other';
}

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

async function loadSeasonDates() {
  data.seasonStart = null;
  data.seasonEnd = null;
  data.nextPurgeDate = null;
  data.nextPurgeAt = null;
  data.purgeNotes = null;
  try {
    const { data: rows } = await window.supabaseClient.from('settings').select('key, value').in('key', [
      'season_start', 'season_end', 'next_purge_date', 'next_purge_at', 'purge_notes'
    ]);
    (rows || []).forEach(r => {
      if (r.key === 'season_start') data.seasonStart = r.value || null;
      if (r.key === 'season_end') data.seasonEnd = r.value || null;
      if (r.key === 'next_purge_date') data.nextPurgeDate = r.value || null;
      if (r.key === 'next_purge_at') data.nextPurgeAt = r.value || null;
      if (r.key === 'purge_notes') data.purgeNotes = r.value || null;
    });
    if (!data.nextPurgeAt && data.nextPurgeDate) {
      data.nextPurgeAt = data.nextPurgeDate + 'T12:00:00';
    }
  } catch (e) {
    console.warn('season dates', e);
  }
}

async function savePurgeSchedule(dateStr, timeStr, notes) {
  let iso = '';
  if (dateStr) {
    const t = timeStr || '12:00';
    iso = dateStr + 'T' + t + ':00';
  }
  await window.supabaseClient.from('settings').upsert({ key: 'next_purge_date', value: dateStr || '' });
  await window.supabaseClient.from('settings').upsert({ key: 'next_purge_at', value: iso });
  await window.supabaseClient.from('settings').upsert({ key: 'purge_notes', value: notes || '' });
  data.nextPurgeDate = dateStr || null;
  data.nextPurgeAt = iso || null;
  data.purgeNotes = notes || null;
}

function getLastPlacePin(division) {
  const teams = Object.entries(data.users)
    .filter(([_, u]) => u.division === division && !u.purged)
    .map(([pin, u]) => ({ pin, points: data.points[pin] || 0, name: u.name }))
    .sort((a, b) => a.points - b.points || a.name.localeCompare(b.name));
  return teams[0] || null;
}

async function checkAndRunScheduledPurge() {
  const whenStr = data.nextPurgeAt;
  if (!whenStr) return false;
  const when = new Date(whenStr);
  if (isNaN(when.getTime()) || Date.now() < when.getTime()) return false;

  try {
    const { error } = await window.supabaseClient.from('purge_log').insert({
      scheduled_for: whenStr,
      ran_at: new Date().toISOString()
    });
    if (error) {
      if (error.code === '23505' || String(error.message || '').toLowerCase().includes('duplicate')) {
        return false;
      }
      console.warn('purge_log claim failed', error);
      return false;
    }
  } catch (e) {
    console.warn('purge_log', e);
    return false;
  }

  await executePurgeCore({ auto: true });
  return true;
}

async function executePurgeCore(opts = {}) {
  const auto = !!opts.auto;
  const eastVictim = getLastPlacePin('east');
  const westVictim = getLastPlacePin('west');
  if (!eastVictim && !westVictim) {
    if (!auto) alert('No teams to purge.');
    return { ok: false, victims: [] };
  }

  if (!auto) {
    const lines = [];
    if (eastVictim) lines.push('EAST: ' + eastVictim.name + ' (' + eastVictim.points + ' pts)');
    if (westVictim) lines.push('WEST: ' + westVictim.name + ' (' + westVictim.points + ' pts)');
    if (!confirm('PURGE these last-place teams?\n\n' + lines.join('\n') + '\n\nTheir rosters will go to free agency.')) {
      return { ok: false, victims: [] };
    }
  }

  const victims = [eastVictim, westVictim].filter(Boolean);
  for (const v of victims) {
    const u = data.users[v.pin];
    await window.supabaseClient.from('teams').update({ roster: [], purged: true }).eq('pin', v.pin);
    if (u) { u.roster = []; u.purged = true; }
  }

  try {
    for (const v of victims) {
      const msg = 'RED ALERT: ' + v.name + ' has been PURGED from the league. Their roster is in free agency. Check the waiver deadline.';
      for (const [pin, u] of Object.entries(data.users)) {
        if (u.division && !u.readOnly) {
          await notifyTradeUpdate(pin, msg);
        }
      }
    }
  } catch (e) {
    console.warn('purge notify', e);
  }

  try {
    if (data.nextPurgeAt) {
      await window.supabaseClient.from('purge_log').update({
        east_pin: eastVictim?.pin || null,
        west_pin: westVictim?.pin || null
      }).eq('scheduled_for', data.nextPurgeAt);
    }
  } catch (e) {}

  await loadAllData();
  renderStandings();
  renderLeagueRosters();
  if (typeof renderWaiver === 'function') renderWaiver();

  const summary = victims.map(v => v.name).join(', ');
  const el = document.getElementById('purge-run-msg');
  if (el) {
    el.textContent = (auto ? 'Auto-purge complete: ' : 'Purge complete: ') + summary;
    el.className = 'text-sm mt-2 text-emerald-400';
  }
  if (!auto) {
    alert('Purge complete.\n' + summary + '\nSet the waiver wire deadline so everyone can claim free agents.');
  } else {
    console.log('Auto-purge complete', summary);
  }
  return { ok: true, victims };
}

async function runPurgeNow() {
  if (typeof isReadOnlyViewer === 'function' && isReadOnlyViewer()) {
    alert('View only');
    return;
  }
  if (!isCommissioner()) {
    alert('Commissioner only');
    return;
  }
  await executePurgeCore({ auto: false });
}


async function saveSeasonDates(start, end) {
  if (isReadOnlyViewer()) return;
  await window.supabaseClient.from('settings').upsert({ key: 'season_start', value: start || '' });
  await window.supabaseClient.from('settings').upsert({ key: 'season_end', value: end || '' });
  data.seasonStart = start || null;
  data.seasonEnd = end || null;
}

async function loadCalendarEvents() {
  data.calendarEvents = [];
  try {
    const { data: rows, error } = await window.supabaseClient
      .from('calendar_events')
      .select('*')
      .order('event_date', { ascending: true, nullsFirst: false });
    if (error) {
      console.warn('calendar_events', error);
      return;
    }
    data.calendarEvents = (rows || []).map(r => ({
      ...r,
      event_type: normalizeEventType(r.event_type)
    }));
  } catch (e) {
    console.warn(e);
  }
}

async function addCalendarEvent(ev) {
  if (isReadOnlyViewer()) throw new Error('View only');
  const row = {
    name: (ev.name || '').trim(),
    event_type: normalizeEventType(ev.event_type || 'other'),
    frequency: 'once',
    event_date: ev.event_date || null,
    notes: ev.notes || null
  };
  // Only include day_of_week if column expects it and we have a value
  if (ev.day_of_week != null && ev.day_of_week !== '' && !Number.isNaN(Number(ev.day_of_week))) {
    row.day_of_week = Number(ev.day_of_week);
  }
  const { data: inserted, error } = await window.supabaseClient
    .from('calendar_events')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  if (inserted) {
    data.calendarEvents = data.calendarEvents || [];
    data.calendarEvents.push(inserted);
  } else {
    await loadCalendarEvents();
  }
}

async function updateCalendarEvent(id, ev) {
  if (isReadOnlyViewer()) throw new Error('View only');
  if (!id) throw new Error('Missing event id');
  const row = {
    name: (ev.name || '').trim(),
    event_type: normalizeEventType(ev.event_type || 'other'),
    frequency: 'once',
    event_date: ev.event_date || null,
    notes: ev.notes || null,
    day_of_week: null
  };
  const { data: updated, error } = await window.supabaseClient
    .from('calendar_events')
    .update(row)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!updated) throw new Error('Update failed — event not found. Clear the form and Add as new.');
  const i = (data.calendarEvents || []).findIndex(e => String(e.id) === String(id));
  if (i >= 0) data.calendarEvents[i] = updated;
  else await loadCalendarEvents();
}

async function deleteCalendarEvent(id) {
  if (isReadOnlyViewer()) return;
  await window.supabaseClient.from('calendar_events').delete().eq('id', id);
  data.calendarEvents = (data.calendarEvents || []).filter(e => e.id !== id);
}

function clearCalEventForm() {
  const idEl = document.getElementById('cal-ev-id');
  if (idEl) idEl.value = '';
  const name = document.getElementById('cal-ev-name');
  if (name) name.value = '';
  const notes = document.getElementById('cal-ev-notes');
  if (notes) notes.value = '';
  const btn = document.getElementById('cal-ev-add');
  if (btn) btn.textContent = 'Add Event';
  document.getElementById('cal-ev-cancel')?.classList.add('hidden');
}

function fillCalEventForm(ev) {
  if (!ev) return;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val == null ? '' : String(val);
  };
  set('cal-ev-id', ev.id || '');
  set('cal-ev-name', ev.name || '');
  set('cal-ev-type', ev.event_type || 'other');
  set('cal-ev-freq', ev.frequency || 'once');
  if (ev.day_of_week != null && ev.day_of_week !== '') set('cal-ev-day', ev.day_of_week);
  set('cal-ev-date', ev.event_date || '');
  set('cal-ev-notes', ev.notes || '');
  const btn = document.getElementById('cal-ev-add');
  if (btn) btn.textContent = 'Save Changes';
  document.getElementById('cal-ev-cancel')?.classList.remove('hidden');
  // Highlight the form so Devin sees it filled
  const nameEl = document.getElementById('cal-ev-name');
  if (nameEl) {
    nameEl.focus();
    nameEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nameEl.classList.add('ring-2', 'ring-aew-gold');
    setTimeout(() => nameEl.classList.remove('ring-2', 'ring-aew-gold'), 1500);
  }
}

function renderSeasonDatesBanner() {
  const el = document.getElementById('season-dates-banner');
  if (!el) return;
  if (!data.seasonStart && !data.seasonEnd) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const fmt = (s) => {
    if (!s) return '—';
    const d = new Date(s + 'T12:00:00');
    return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  el.innerHTML = `<span class="text-aew-gold font-semibold">Season</span> ${fmt(data.seasonStart)} → ${fmt(data.seasonEnd)}`;
  el.classList.remove('hidden');
}

function renderCalendar() {
  renderSeasonDatesBanner();
  const weekly = [];
  const specials = [];
  const ppvs = [];
  const other = [];

  (data.calendarEvents || []).forEach(ev => {
    const t = normalizeEventType(ev.event_type);
    ev.event_type = t;
    if (t === 'weekly_tv') weekly.push(ev);
    else if (t === 'special_tv') specials.push(ev);
    else if (t === 'ppv') ppvs.push(ev);
    else other.push(ev);
  });

  const byDate = (a, b) => String(a.event_date || '').localeCompare(String(b.event_date || ''));
  weekly.sort(byDate);
  specials.sort(byDate);
  ppvs.sort(byDate);

  const formatEvDate = (ev) => {
    if (!ev.event_date) return null;
    const d = new Date(String(ev.event_date).slice(0, 10) + 'T12:00:00');
    if (isNaN(d.getTime())) return String(ev.event_date);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  const card = (ev) => {
    const dateStr = formatEvDate(ev);
    return `
    <div class="bg-aew-card rounded-xl border border-gray-800 px-4 py-3">
      <div class="font-semibold">${ev.name || 'Untitled'}</div>
      <div class="text-sm mt-1 ${dateStr ? 'text-white' : 'text-red-400'}">${dateStr || 'No date set — edit in Commissioner'}</div>
      <div class="text-xs text-gray-400 mt-0.5">${CAL_TYPES[ev.event_type] || ev.event_type}</div>
      ${ev.notes ? `<div class="text-xs text-gray-500 mt-1">${ev.notes}</div>` : ''}
    </div>`;
  };

  const fill = (id, list) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = list.length
      ? list.map(card).join('')
      : '<p class="text-gray-500 text-sm">None yet</p>';
  };

  fill('cal-weekly', weekly);
  fill('cal-specials', specials);
  fill('cal-ppv', ppvs);
  fill('cal-upcoming', ppvs); // legacy id
  fill('cal-other', other);
}

function renderCalendarAdmin() {
  const start = document.getElementById('season-start-date');
  const end = document.getElementById('season-end-date');
  if (start) start.value = data.seasonStart || '';
  if (end) end.value = data.seasonEnd || '';
  const pd = document.getElementById('purge-date');
  const pt = document.getElementById('purge-time');
  const pn = document.getElementById('purge-notes');
  if (pd) pd.value = data.nextPurgeDate || '';
  if (pn) pn.value = data.purgeNotes || '';
  if (pt) {
    if (data.nextPurgeAt && data.nextPurgeAt.includes('T')) {
      const part = data.nextPurgeAt.split('T')[1] || '';
      pt.value = part.slice(0, 5);
    } else {
      pt.value = '';
    }
  }

  const list = document.getElementById('cal-ev-admin-list');
  if (!list) return;
  const events = data.calendarEvents || [];
  if (!events.length) {
    list.innerHTML = '<p class="text-gray-500">No events yet</p>';
    return;
  }
  list.innerHTML = events.map(ev => {
    const extra = ev.event_date || '';
    const noteBit = ev.notes ? ` · ${ev.notes}` : '';
    return `<div class="flex justify-between gap-2 items-center bg-black/40 rounded-lg px-3 py-2">
      <div class="min-w-0">
        <div class="font-medium truncate">${ev.name}</div>
        <div class="text-xs text-gray-500">${CAL_TYPES[ev.event_type] || ev.event_type}${ev.event_date ? ' · ' + ev.event_date : ' · <span class="text-red-400">no date</span>'}${noteBit}</div>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        <button type="button" data-cal-edit="${ev.id}" class="text-aew-gold text-sm" title="Edit">✏️</button>
        <button type="button" data-cal-del="${ev.id}" class="text-red-400 text-xs">Delete</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-cal-edit]').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-cal-edit') || btn.dataset.calEdit;
      const ev = (data.calendarEvents || []).find(x => String(x.id) === String(id));
      if (!ev) {
        alert('Could not load that event for editing. Try Refresh, then click the pencil again.');
        console.warn('cal edit miss', id, data.calendarEvents);
        return;
      }
      fillCalEventForm(ev);
    };
  });
  list.querySelectorAll('[data-cal-del]').forEach(btn => {
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('Delete this event?')) return;
      const id = btn.getAttribute('data-cal-del') || btn.dataset.calDel;
      await deleteCalendarEvent(id);
      clearCalEventForm();
      renderCalendarAdmin();
      renderCalendar();
    };
  });
}


async function renameWrestlerEverywhere(fromName, toName) {
  if (isReadOnlyViewer()) return { ok: false, error: 'View only' };
  fromName = (fromName || '').trim();
  toName = (toName || '').trim();
  if (!fromName || !toName) return { ok: false, error: 'Both names required' };
  if (fromName.toLowerCase() === toName.toLowerCase() && fromName !== toName) {
    // case-only change still ok
  } else if (fromName.toLowerCase() === toName.toLowerCase()) {
    return { ok: false, error: 'Names are the same' };
  }

  const sb = window.supabaseClient;
  const fromLower = fromName.toLowerCase();

  // master_roster: delete old, insert new
  await sb.from('master_roster').delete().ilike('name', fromName);
  // also try exact
  const { data: masterRows } = await sb.from('master_roster').select('name');
  for (const r of masterRows || []) {
    if (r.name.toLowerCase() === fromLower) {
      await sb.from('master_roster').delete().eq('name', r.name);
    }
  }
  const exists = (masterRows || []).some(r => r.name.toLowerCase() === toName.toLowerCase());
  if (!exists) {
    await sb.from('master_roster').insert({ name: toName });
  }

  // teams rosters
  const { data: teams } = await sb.from('teams').select('pin, roster');
  for (const t of teams || []) {
    const roster = t.roster || [];
    let changed = false;
    const next = roster.map(w => {
      if ((w || '').toLowerCase() === fromLower) {
        changed = true;
        return toName;
      }
      return w;
    });
    if (changed) {
      await sb.from('teams').update({ roster: next }).eq('pin', t.pin);
      if (data.users[t.pin]) data.users[t.pin].roster = next;
    }
  }

  // wrestler_points
  const { data: pts } = await sb.from('wrestler_points').select('name, points, prior_points');
  let fromPts = null;
  for (const r of pts || []) {
    if (r.name.toLowerCase() === fromLower) fromPts = r;
  }
  if (fromPts) {
    const toExists = (pts || []).find(r => r.name.toLowerCase() === toName.toLowerCase());
    if (toExists) {
      // merge points into target, delete old
      const merged = Math.max(Number(toExists.points) || 0, Number(fromPts.points) || 0);
      await sb.from('wrestler_points').update({ points: merged }).eq('name', toExists.name);
      await sb.from('wrestler_points').delete().eq('name', fromPts.name);
    } else {
      await sb.from('wrestler_points').update({ name: toName }).eq('name', fromPts.name);
    }
  }

  // portraits
  try {
    const { data: ports } = await sb.from('wrestler_portraits').select('name, image_url');
    for (const r of ports || []) {
      if (r.name.toLowerCase() === fromLower) {
        await sb.from('wrestler_portraits').delete().eq('name', r.name);
        await sb.from('wrestler_portraits').upsert({ name: toName, image_url: r.image_url });
      }
    }
  } catch (e) {}

  // draft picks
  try {
    const { data: picks } = await sb.from('draft_picks').select('id, wrestler');
    for (const p of picks || []) {
      if ((p.wrestler || '').toLowerCase() === fromLower) {
        await sb.from('draft_picks').update({ wrestler: toName }).eq('id', p.id);
      }
    }
  } catch (e) {}

  // claims ranked lists
  try {
    const { data: claims } = await sb.from('claims').select('pin, ranked, drop, drops');
    for (const c of claims || []) {
      let ranked = c.ranked || [];
      let changed = false;
      ranked = ranked.map(w => {
        if ((w || '').toLowerCase() === fromLower) { changed = true; return toName; }
        return w;
      });
      let drop = c.drop;
      if (drop && drop.toLowerCase() === fromLower) { drop = toName; changed = true; }
      if (changed) await sb.from('claims').update({ ranked, drop }).eq('pin', c.pin);
    }
  } catch (e) {}

  // refresh local master roster
  data.masterRoster = (data.masterRoster || [])
    .map(w => w.toLowerCase() === fromLower ? toName : w)
    .filter((w, i, arr) => arr.findIndex(x => x.toLowerCase() === w.toLowerCase()) === i);
  if (!data.masterRoster.some(w => w.toLowerCase() === toName.toLowerCase())) {
    data.masterRoster.push(toName);
    data.masterRoster.sort((a, b) => a.localeCompare(b));
  }
  await loadWrestlerPoints();
  await loadPortraits();
  return { ok: true };
}

async function deleteWrestlerEverywhere(name) {
  if (isReadOnlyViewer()) return { ok: false, error: 'View only' };
  name = (name || '').trim();
  if (!name) return { ok: false, error: 'Name required' };
  const sb = window.supabaseClient;
  const lower = name.toLowerCase();

  // master
  const { data: masterRows } = await sb.from('master_roster').select('name');
  for (const r of masterRows || []) {
    if (r.name.toLowerCase() === lower) await sb.from('master_roster').delete().eq('name', r.name);
  }

  // teams
  const { data: teams } = await sb.from('teams').select('pin, roster');
  for (const t of teams || []) {
    const roster = t.roster || [];
    const next = roster.filter(w => (w || '').toLowerCase() !== lower);
    if (next.length !== roster.length) {
      await sb.from('teams').update({ roster: next }).eq('pin', t.pin);
      if (data.users[t.pin]) data.users[t.pin].roster = next;
    }
  }

  // points
  const { data: pts } = await sb.from('wrestler_points').select('name');
  for (const r of pts || []) {
    if (r.name.toLowerCase() === lower) await sb.from('wrestler_points').delete().eq('name', r.name);
  }

  // portraits
  try {
    const { data: ports } = await sb.from('wrestler_portraits').select('name');
    for (const r of ports || []) {
      if (r.name.toLowerCase() === lower) await sb.from('wrestler_portraits').delete().eq('name', r.name);
    }
  } catch (e) {}

  // claims
  try {
    const { data: claims } = await sb.from('claims').select('pin, ranked, drop, drops');
    for (const c of claims || []) {
      let ranked = (c.ranked || []).filter(w => (w || '').toLowerCase() !== lower);
      let drop = c.drop && c.drop.toLowerCase() === lower ? null : c.drop;
      if (ranked.length !== (c.ranked || []).length || drop !== c.drop) {
        await sb.from('claims').update({ ranked, drop }).eq('pin', c.pin);
      }
    }
  } catch (e) {}

  data.masterRoster = (data.masterRoster || []).filter(w => w.toLowerCase() !== lower);
  if (data.wrestlerPoints) delete data.wrestlerPoints[lower];
  if (data.portraits) delete data.portraits[lower];
  return { ok: true };
}

function fillWrestlerNameList() {
  const dl = document.getElementById('wrestler-name-list');
  if (!dl) return;
  const names = new Set(data.masterRoster || []);
  Object.values(data.users || {}).forEach(u => (u.roster || []).forEach(w => names.add(w)));
  dl.innerHTML = [...names].sort((a, b) => a.localeCompare(b)).map(n => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('');
}


async function loadTradeBlocks() {
  data.tradeBlocks = {}; // pin -> [wrestler names]
  try {
    const { data: rows, error } = await window.supabaseClient.from('trade_blocks').select('pin, wrestlers');
    if (error) {
      console.warn('trade_blocks', error);
      return;
    }
    (rows || []).forEach(r => {
      data.tradeBlocks[r.pin] = r.wrestlers || [];
    });
  } catch (e) {
    console.warn(e);
  }
}

function isOnTradeBlock(pin, wrestler) {
  const list = data.tradeBlocks?.[pin] || [];
  return list.some(w => (w || '').toLowerCase() === (wrestler || '').toLowerCase());
}

async function saveTradeBlock(pin, wrestlers) {
  if (isReadOnlyViewer()) throw new Error('View only');
  const { error } = await window.supabaseClient.from('trade_blocks').upsert({
    pin,
    wrestlers: wrestlers || [],
    updated_at: new Date().toISOString()
  }, { onConflict: 'pin' });
  if (error) throw error;
  data.tradeBlocks = data.tradeBlocks || {};
  data.tradeBlocks[pin] = wrestlers || [];
}

async function toggleTradeBlock(wrestler) {
  if (guardReadOnly('change trade block')) return;
  if (!currentUser) return;
  const list = [...(data.tradeBlocks?.[currentUser] || [])];
  const i = list.findIndex(w => w.toLowerCase() === wrestler.toLowerCase());
  if (i >= 0) list.splice(i, 1);
  else list.push(wrestler);
  await saveTradeBlock(currentUser, list);
}

let currentUser = null;
let claimRanked = [];
let claimDrops = []; // parallel to claimRanked — drop for that priority;
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
    const pinKey = String(t.pin || '').trim().toLowerCase();
    if (!pinKey) return;
    data.users[pinKey] = {
      name: t.name,
      teamName: (t.team_name || '').trim() || null,
      division: t.division,
      isCommissioner: t.is_commissioner,
      maxRoster: t.max_roster || 8,
      roster: t.roster || [],
      lastDelta: (t.last_delta === null || t.last_delta === undefined) ? null : t.last_delta,
      purged: !!t.purged
    };
    data.points[pinKey] = t.points || 0;
  });
  console.log('Loaded PINs:', Object.keys(data.users));

  // Read-only observer PIN (view everything, change nothing)
  data.users['doublej'] = {
    name: 'Double J',
    division: null,
    isCommissioner: false,
    readOnly: true,
    maxRoster: 0,
    roster: [],
    lastDelta: null
  };

  // Master roster
  const { data: master } = await sb.from('master_roster').select('name');
  data.masterRoster = (master || []).map(r => r.name).sort((a,b) => a.localeCompare(b));

  // Claims
  const { data: claims } = await sb.from('claims').select('*');
  data.claims = {};
  (claims || []).forEach(c => {
    data.claims[c.pin] = {
      ranked: c.ranked || [],
      drop: c.drop || null,
      drops: c.drops || (c.drop ? [c.drop] : []),
      submittedAt: c.submitted_at
    };
  });
  // Merge drops from settings (for DBs that lack claims.drop column)
  try {
    const { data: dropRows } = await sb.from('settings').select('key, value').like('key', 'claim_drops_%');
    (dropRows || []).forEach(row => {
      const pin = String(row.key || '').replace(/^claim_drops_/, '');
      if (!pin || !data.claims[pin]) return;
      let parsed = row.value;
      try { parsed = typeof parsed === 'string' ? JSON.parse(parsed) : parsed; } catch (_) {}
      if (parsed && typeof parsed === 'object') {
        if (parsed.drop) data.claims[pin].drop = parsed.drop;
        if (Array.isArray(parsed.drops)) data.claims[pin].drops = parsed.drops;
      }
    });
  } catch (e) { console.warn('claim drops load', e); }

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
  await loadPortraits();
  await loadFantasyChampion();
  await loadSeasonDates();
  await loadCalendarEvents();
  await loadTradeBlocks();
  await updateDraftScheduleBanner();
  try { await checkAndRunScheduledPurge(); } catch (e) { console.warn('auto purge', e); }
  // pending alerts checked in enterApp
}

async function saveTeamPoints(pin, points, lastDelta) {
  if (isReadOnlyViewer()) throw new Error('View only');
  const payload = { points };
  if (lastDelta !== undefined) payload.last_delta = lastDelta;
  const { error } = await window.supabaseClient.from('teams').update(payload).eq('pin', pin);
  if (error && lastDelta !== undefined) {
    // Column may not exist yet — still save points
    await window.supabaseClient.from('teams').update({ points }).eq('pin', pin);
  }
  data.points[pin] = points;
  if (lastDelta !== undefined && data.users[pin]) data.users[pin].lastDelta = lastDelta;
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

async function saveClaim(pin, ranked, drop = null, drops = null) {
  const dropPrimary = drop || (Array.isArray(drops) && drops[0]) || null;
  const dropsArr = Array.isArray(drops) && drops.length ? drops : (dropPrimary ? [dropPrimary] : []);
  const submitted_at = new Date().toISOString();
  const sb = window.supabaseClient;

  // Try full schema (drop + drops columns). Fall back if table was created without them.
  const attempts = [
    { pin, ranked, drop: dropPrimary, drops: dropsArr, submitted_at },
    { pin, ranked, drop: dropPrimary, submitted_at },
    { pin, ranked, submitted_at }
  ];
  let lastErr = null;
  let saved = false;
  for (const payload of attempts) {
    const { error } = await sb.from('claims').upsert(payload, { onConflict: 'pin' });
    if (!error) { saved = true; break; }
    lastErr = error;
    const msg = String(error.message || error.details || error || '').toLowerCase();
    // only continue fallback on missing-column style errors
    if (!msg.includes('schema cache') && !msg.includes('column') && !msg.includes('drops') && !msg.includes("'drop'")) {
      throw error;
    }
  }
  if (!saved) throw lastErr || new Error('Could not save claim');

  // Always persist drops in settings so process works even without claims.drop column
  try {
    await sb.from('settings').upsert({
      key: 'claim_drops_' + pin,
      value: JSON.stringify({ drop: dropPrimary, drops: dropsArr })
    });
  } catch (e) {
    console.warn('claim drops settings', e);
  }

  data.claims[pin] = {
    ranked,
    drop: dropPrimary,
    drops: dropsArr,
    submittedAt: submitted_at
  };
}

async function clearClaim(pin) {
  await window.supabaseClient.from('claims').delete().eq('pin', pin);
  try {
    await window.supabaseClient.from('settings').delete().eq('key', 'claim_drops_' + pin);
  } catch (_) {}
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

function isReadOnlyViewer() {
  return !!(currentUser && (currentUser === 'doublej' || data.users[currentUser]?.readOnly));
}

/** True commissioner — can make changes */
function isCommissioner() {
  return !!(currentUser && data.users[currentUser]?.isCommissioner && !isReadOnlyViewer());
}

/** Can open Commissioner / Broadcast tabs (commish or read-only observer) */
function canViewCommissionerTools() {
  return isCommissioner() || isReadOnlyViewer();
}


function applyReadOnlyMode() {
  if (!isReadOnlyViewer()) return;
  // Disable buttons / inputs that change data (keep navigation working)
  const root = document.getElementById('app');
  if (!root) return;
  root.querySelectorAll('button, input, select, textarea').forEach(el => {
    // keep nav + logout + refresh + tab switches
    if (el.classList.contains('nav-btn')) return;
    if (el.id === 'logout-btn' || el.id === 'refresh-btn' || el.id === 'soft-refresh-btn') return;
    if (el.closest && el.closest('nav')) return;
    const id = el.id || '';
    if (id === 'pin-input' || id === 'login-btn') return;
    // allow opening tabs
    if (el.dataset && el.dataset.tab) return;
    if (el.type === 'button' && (el.id || '').includes('tx-tab')) return;
    el.disabled = true;
    el.classList.add('opacity-60', 'cursor-not-allowed');
  });
  // Banner
  let bar = document.getElementById('readonly-banner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'readonly-banner';
    bar.className = 'bg-yellow-900/40 border-b border-yellow-700 text-yellow-200 text-center text-sm py-2 px-3';
    bar.textContent = 'View-only mode — you can see everything but cannot make changes.';
    const app = document.getElementById('app');
    if (app && app.firstChild) app.insertBefore(bar, app.firstChild);
    else if (app) app.prepend(bar);
  }
}

function guardReadOnly(actionLabel) {
  if (!isReadOnlyViewer()) return false;
  alert('View only — this PIN cannot ' + (actionLabel || 'make changes') + '.');
  return true;
}

// ---------- UI ----------

/** Display name on standings / lists (custom team name or owner name) */
function teamDisplayName(pin) {
  const u = data.users[pin];
  if (!u) return pin;
  return (u.teamName || u.name || pin);
}

/** Owner identity for hover tooltip */
function teamOwnerLabel(pin) {
  const u = data.users[pin];
  if (!u) return pin;
  return u.name || pin;
}

function teamNameHtml(pin, extraClass = '') {
  const display = teamDisplayName(pin);
  const owner = teamOwnerLabel(pin);
  const title = owner !== display
    ? ('Owner: ' + owner)
    : ('Owner: ' + owner);
  return `<span class="${extraClass}" title="${title.replace(/"/g, '&quot;')}">${display}</span>`;
}

async function saveTeamName(pin, teamName) {
  if (typeof isReadOnlyViewer === 'function' && isReadOnlyViewer()) {
    alert('View only');
    return { ok: false };
  }
  teamName = (teamName || '').trim();
  if (teamName.length > 40) {
    alert('Team name max 40 characters');
    return { ok: false };
  }
  // Empty = clear custom name (fall back to owner name) — always allowed
  if (teamName) {
    const lower = teamName.toLowerCase();
    const conflict = Object.entries(data.users).find(([p, u]) => {
      if (p === pin) return false;
      if (!u || u.readOnly) return false;
      const theirCustom = (u.teamName || '').trim().toLowerCase();
      const theirOwner = (u.name || '').trim().toLowerCase();
      if (theirCustom && theirCustom === lower) return true;
      if (theirOwner === lower) return true;
      return false;
    });
    if (conflict) {
      const who = data.users[conflict[0]]?.name || conflict[0];
      alert('That team name is already taken (used by ' + who + '). Pick a different name.');
      return { ok: false, error: 'duplicate' };
    }
  }
  const { error } = await window.supabaseClient.from('teams').update({
    team_name: teamName || null
  }).eq('pin', pin);
  if (error) {
    alert('Could not save team name: ' + error.message + '\nRun the team_name SQL if needed.');
    return { ok: false, error };
  }
  if (data.users[pin]) data.users[pin].teamName = teamName || null;
  return { ok: true };
}

function showTab(tabId) {
  // Soft refresh data when switching tabs (except first paint)
  if (currentUser) softRefresh(false);
  if (!document.getElementById('tab-' + tabId)) tabId = 'standings';
  try { localStorage.setItem('aew_current_tab', tabId); } catch (e) {}
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');

  if (tabId === 'standings') renderStandings();
  if (tabId === 'calendar') renderCalendar();
  if (tabId === 'myteam') renderMyTeam();
  if (tabId === 'transactions') { renderWaiver(); }
  if (tabId === 'draft') { renderDraft(); }
  if (tabId === 'broadcast') { renderBroadcastTab(); }
  if (tabId === 'past-champions') { renderPastChampions(); }
  if (tabId === 'rules') renderScoringTable();
  if (tabId === 'commissioner') renderCommissioner();
}

function renderStandings() {
  // Upcoming purge notice
  const notice = document.getElementById('purge-standings-notice');
  if (notice) {
    if (data.nextPurgeAt || data.nextPurgeDate) {
      const d = new Date(data.nextPurgeAt || (data.nextPurgeDate + 'T12:00:00'));
      const label = isNaN(d.getTime())
        ? (data.nextPurgeAt || data.nextPurgeDate)
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      notice.innerHTML = `<span class="text-red-400 font-bold">PURGE</span> <strong>${label}</strong>${data.purgeNotes ? ' — ' + data.purgeNotes : ''}. Last place in each division is removed; rosters go to free agency.`;
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
      notice.innerHTML = '';
    }
  }

  const rankSort = (a, b) => {
    if (!!a.purged !== !!b.purged) return a.purged ? 1 : -1; // purged at bottom
    return b.points - a.points;
  };
  const east = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'east')
    .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0, maxRoster: u.maxRoster, lastDelta: u.lastDelta, purged: !!u.purged }))
    .sort(rankSort);

  const west = Object.entries(data.users)
    .filter(([_, u]) => u.division === 'west')
    .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0, maxRoster: u.maxRoster, lastDelta: u.lastDelta, purged: !!u.purged }))
    .sort(rankSort);

  const renderList = (list, containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = list.map((t, i) => {
      const delta = data.users[t.pin]?.lastDelta;
      // null/undefined = no show recorded yet → hide; 0 = scored zero → red 0; >0 green; <0 red
      let deltaHtml = '';
      if (delta === 0) {
        deltaHtml = `<span class="text-red-400 text-sm font-semibold ml-2">0</span>`;
      } else if (typeof delta === 'number' && delta > 0) {
        deltaHtml = `<span class="text-emerald-400 text-sm font-semibold ml-2">+${delta}</span>`;
      } else if (typeof delta === 'number' && delta < 0) {
        deltaHtml = `<span class="text-red-400 text-sm font-semibold ml-2">${delta}</span>`;
      }
      return `
      <div class="standing-row">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-gray-500 w-5 text-right flex-shrink-0">${i + 1}</span>
          <span class="min-w-0">
            <span class="font-semibold truncate inline-block max-w-full ${t.purged ? 'line-through text-red-400/80' : ''}" title="Owner: ${teamOwnerLabel(t.pin)}">${teamDisplayName(t.pin)}</span>
            ${teamDisplayName(t.pin) !== teamOwnerLabel(t.pin) ? `<span class="block text-[10px] text-gray-500 truncate" title="Owner: ${teamOwnerLabel(t.pin)}">${teamOwnerLabel(t.pin)}</span>` : ''}
          </span>${t.purged ? '<span class="text-[10px] font-bold uppercase tracking-wide text-red-500 border border-red-500/60 rounded px-1.5 py-0.5 ml-1.5 flex-shrink-0">PURGED</span>' : ''}${t.purged ? '' : champCrown(t.pin)}
          ${t.maxRoster > 8 ? '<span class="text-xs bg-emerald-900 text-emerald-300 px-1.5 py-0.5 rounded flex-shrink-0">9</span>' : ''}
        </div>
        <div class="flex items-center gap-1 flex-shrink-0 ml-2">
          <span class="font-bold text-lg">${t.points}</span>
          ${deltaHtml}
        </div>
      </div>`;
    }).join('');
  };

  renderList(east, 'east-standings');
  renderList(west, 'west-standings');
}

function renderMyTeam() {
  const u = data.users[currentUser];
  const el = document.getElementById('my-team-content');
  if (!u) return;

  if (isReadOnlyViewer()) {
    el.innerHTML = `<div class="text-center py-12 text-gray-400">
      <p class="text-lg font-semibold text-white mb-2">View-only access</p>
      <p class="text-sm">You can browse Standings, Calendar, League Rosters, Draft, Commissioner tools, and more — but you cannot change anything.</p>
    </div>`;
    return;
  }

  if (u.isCommissioner && !u.division) {
    el.innerHTML = `<div class="text-center py-12 text-gray-500"><p>Commissioner view</p></div>`;
    return;
  }

  const pts = data.points[currentUser] || 0;
  const roster = (u.roster || []).slice().sort((a, b) => getWrestlerPts(b) - getWrestlerPts(a) || a.localeCompare(b));

  const shown = teamDisplayName(currentUser);
  el.innerHTML = `
    <div class="flex items-center justify-between mb-6 gap-4 flex-wrap">
      <div class="min-w-0">
        <h2 class="text-2xl font-bold truncate" title="Owner: ${teamOwnerLabel(currentUser)}">${shown}${champCrown(currentUser)}</h2>
        <p class="text-gray-400 text-sm">${u.division === 'east' ? 'East Coast' : 'West Coast'} • Roster ${roster.length}/${u.maxRoster}</p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <label class="text-xs text-gray-500">Team name</label>
          <input id="my-team-name-input" type="text" maxlength="40" value="${(u.teamName || '').replace(/"/g, '&quot;')}" placeholder="${(u.name || '').replace(/"/g, '&quot;')}" class="bg-black border border-gray-700 rounded-lg px-3 py-1.5 text-sm w-48" />
          <button type="button" id="my-team-name-save" class="bg-aew-gold text-black font-bold text-xs px-3 py-1.5 rounded-lg">Save</button>
          <span id="my-team-name-msg" class="text-xs text-gray-500">Everyone can hover a team name to see the owner</span>
        </div>
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
        const onBlock = isOnTradeBlock(currentUser, w);
        return `<div class="bg-black/50 rounded-lg px-3 py-2 text-sm ${gold} flex items-center gap-2 relative">
          ${portraitHtml(w, 'h-28 w-28')}
          <span class="flex items-center flex-1 min-w-0 truncate">${w}${badge}</span>
          <span class="text-gray-400 font-mono text-xs flex-shrink-0">${pts}</span>
          <button type="button" data-trade-block="${w.replace(/"/g, '&quot;')}" class="text-xs px-2 py-1 rounded border ${onBlock ? 'border-emerald-500 text-emerald-400' : 'border-gray-600 text-gray-400'} hover:border-gray-400 flex-shrink-0" title="Trade block">${onBlock ? '🤝 On block' : 'Trade block'}</button>
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

  let list;
  if (!division) {
    list = data.masterRoster.slice();
  } else {
    // Case-insensitive set of taken names in this division
    const taken = new Set();
    Object.values(data.users).forEach(u => {
      if (u.division === division) {
        (u.roster || []).forEach(w => taken.add(w.toLowerCase().trim()));
      }
    });
    list = data.masterRoster.filter(w => !taken.has(w.toLowerCase().trim()));
  }

  // Sort highest points first, then name
  return list.sort((a, b) => {
    const pb = getWrestlerPts(b);
    const pa = getWrestlerPts(a);
    if (pb !== pa) return pb - pa;
    return a.localeCompare(b);
  });
}

function renderWaiver() {
  updateWaiverDeadlineBanner();
  const available = getAvailableWrestlers();
  const container = document.getElementById('available-wrestlers');
  if (!container) return;

  if (available.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm p-4 text-center">No available wrestlers (upload master roster first)</p>';
  } else {
    container.innerHTML = available.map(w => {
      const pts = getWrestlerPts(w);
      return `<div class="wrestler-chip px-2 py-2 rounded-lg text-sm border border-transparent hover:border-gray-600 flex items-center gap-2" data-name="${w}">
        ${portraitHtml(w, 'h-24 w-24')}
        <span class="flex-1 truncate">${w}</span>
        <span class="text-gray-500 font-mono text-xs flex-shrink-0">${pts}</span>
      </div>`;
    }).join('');
    container.querySelectorAll('.wrestler-chip').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.dataset.name;
        if (claimRanked.includes(name)) return;
        const maxClaims = data.users[currentUser]?.maxRoster || 8;
        if (claimRanked.length >= maxClaims) {
          alert('You can claim up to ' + maxClaims + ' wrestlers (full roster). Remove one from your list to add another.');
          return;
        }
        claimRanked.push(name);
        if (!Array.isArray(claimDrops)) claimDrops = [];
        claimDrops.push('');
        renderClaimList();
      });
    });
  }

  // Load saved claim ONLY if local draft is empty — never wipe in-progress picks
  // (selecting a drop used to re-render and clear everything)
  if (claimRanked.length === 0 && data.claims[currentUser]) {
    const c = data.claims[currentUser];
    claimRanked = [...(c.ranked || [])];
    if (Array.isArray(c.drops) && c.drops.length) {
      claimDrops = [...c.drops];
      while (claimDrops.length < claimRanked.length) claimDrops.push(c.drop || '');
    } else if (c.drop) {
      claimDrops = claimRanked.map(() => c.drop);
    } else {
      claimDrops = claimRanked.map(() => '');
    }
  }
  if (!Array.isArray(claimDrops)) claimDrops = [];
  while (claimDrops.length < claimRanked.length) claimDrops.push('');
  renderClaimList();
  
  renderWaiverFOStatus();

}


async function persistClaimRanked() {
  if (!currentUser || isReadOnlyViewer()) return;
  try {
    if (claimRanked.length === 0 && !claimDrops.filter(Boolean).length) {
      await clearClaim(currentUser);
      return;
    }
    const drops = (claimDrops || []).filter(Boolean);
    await saveClaim(currentUser, [...claimRanked], drops[0] || null, drops);
  } catch (e) {
    console.warn('persistClaimRanked', e.message || e);
  }
}

function renderDropPool() {
  const el = document.getElementById('claim-drop-pool');
  if (!el) return;
  if (!Array.isArray(claimDrops)) claimDrops = [];
  const roster = data.users[currentUser]?.roster || [];
  el.innerHTML = `
    <div class="text-xs text-gray-400 mb-2">Players to drop — add one for a normal 1-for-1, or several for multiple pickups.</div>
    <div class="flex flex-wrap gap-2 mb-2" id="drop-pool-chips">
      ${claimDrops.filter(Boolean).map((d, i) => `
        <span class="inline-flex items-center gap-1 bg-gray-800 border border-gray-600 rounded-full px-3 py-1 text-sm">
          ${d}
          <button type="button" class="text-red-400 remove-drop-pool" data-idx="${i}">✕</button>
        </span>
      `).join('') || '<span class="text-gray-500 text-sm">None yet — add at least one</span>'}
    </div>
    <select id="add-drop-pool-select" class="w-full bg-black border border-gray-600 rounded-lg px-3 py-2 text-sm">
      <option value="">+ Add player to drop…</option>
      ${roster.filter(r => !claimDrops.some(d => (d||'').toLowerCase() === (r||'').toLowerCase())).map(r =>
        `<option value="${String(r).replace(/"/g,'&quot;')}">${r}</option>`
      ).join('')}
    </select>
    <p class="text-[11px] text-gray-500 mt-2">Need 1 pickup? Add 1 drop. Want up to 2? Add 2 drops. Ranked list = priority if someone else gets your first choice.</p>
  `;
  el.querySelectorAll('.remove-drop-pool').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const i = parseInt(btn.getAttribute('data-idx'), 10);
      claimDrops.splice(i, 1);
      renderDropPool();
      renderClaimPreview();
    });
  });
  const addSel = document.getElementById('add-drop-pool-select');
  if (addSel) {
    addSel.addEventListener('change', () => {
      const v = (addSel.value || '').trim();
      if (!v) return;
      if (!claimDrops.some(d => (d||'').toLowerCase() === v.toLowerCase())) {
        claimDrops.push(v);
      }
      renderDropPool();
      renderClaimPreview();
    });
  }
}

function renderClaimPreview() {
  const prev = document.getElementById('claim-preview');
  if (!prev) return;
  if (!claimRanked.length) {
    prev.innerHTML = '';
    return;
  }
  const n = claimDrops.filter(Boolean).length;
  prev.innerHTML = `
    <div class="rounded-lg border border-gray-700 p-3 text-sm space-y-1">
      <div><span class="text-gray-400">Priority adds:</span> ${claimRanked.map((w,i) => `<strong>${i+1}. ${w}</strong>`).join(' → ') || '—'}</div>
      <div><span class="text-gray-400">Drop pool (${n}):</span> ${claimDrops.filter(Boolean).join(', ') || '— none —'}</div>
      <div class="text-aew-gold text-xs mt-1">You can get up to <strong>${n}</strong> wrestler${n===1?'':'s'} this period</div>
    </div>
  `;
}

function renderClaimList() {
  const el = document.getElementById('claim-list');
  if (!el) return;
  if (!Array.isArray(claimDrops)) claimDrops = [];

  if (claimRanked.length === 0) {
    el.innerHTML = '<p class="text-sm text-gray-500 text-center py-6">Tap wrestlers you want (one is fine; more = priority order if your first choices are taken).</p>';
  } else {
    el.innerHTML = claimRanked.map((w, i) => `
      <div class="claim-item flex items-center justify-between gap-2 py-2 border-b border-gray-800">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-aew-gold font-bold text-sm w-6">${i + 1}.</span>
          ${portraitHtml(w, 'h-14 w-14')}
          <span class="truncate font-medium">${w}</span>
        </div>
        <button type="button" class="text-red-400 text-lg px-2 remove-claim" data-idx="${i}">✕</button>
      </div>
    `).join('');
  }

  // Ensure drop pool + preview containers exist inside claim-list area parent
  let pool = document.getElementById('claim-drop-pool');
  let prev = document.getElementById('claim-preview');
  if (!pool && el.parentElement) {
    pool = document.createElement('div');
    pool.id = 'claim-drop-pool';
    pool.className = 'mt-4';
    el.parentElement.appendChild(pool);
  }
  if (!prev && el.parentElement) {
    prev = document.createElement('div');
    prev.id = 'claim-preview';
    prev.className = 'mt-3';
    el.parentElement.appendChild(prev);
  }

  el.querySelectorAll('.remove-claim').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const i = parseInt(btn.getAttribute('data-idx'), 10);
      if (isNaN(i)) return;
      claimRanked.splice(i, 1);
      renderClaimList();
    });
  });
  renderDropPool();
  renderClaimPreview();
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
  try { renderCalendarAdmin(); } catch (e) { console.warn(e); }
  try { fillWrestlerNameList(); } catch (e) {}
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
  populateEditRosterSelect();
  renderFantasyChampSelect();
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
function rosterHas(roster, name) {
  const k = (name || '').toLowerCase().trim();
  return (roster || []).some(w => (w || '').toLowerCase().trim() === k);
}
function rosterWithout(roster, name) {
  const k = (name || '').toLowerCase().trim();
  return (roster || []).filter(w => (w || '').toLowerCase().trim() !== k);
}
function availableHas(list, name) {
  const k = (name || '').toLowerCase().trim();
  return (list || []).some(w => (w || '').toLowerCase().trim() === k);
}
function availableCanonical(list, name) {
  const k = (name || '').toLowerCase().trim();
  return (list || []).find(w => (w || '').toLowerCase().trim() === k) || name;
}

async function reloadClaimsFromDb() {
  const sb = window.supabaseClient;
  if (!sb) return;
  const { data: claims } = await sb.from('claims').select('pin, ranked, drop, drops, submitted_at');
  data.claims = {};
  (claims || []).forEach(c => {
    data.claims[c.pin] = {
      ranked: c.ranked || [],
      drop: c.drop || null,
      drops: c.drops || (c.drop ? [c.drop] : []),
      submittedAt: c.submitted_at
    };
  });
  // Merge drops from settings (for DBs that lack claims.drop column)
  try {
    const { data: dropRows } = await sb.from('settings').select('key, value').like('key', 'claim_drops_%');
    (dropRows || []).forEach(row => {
      const pin = String(row.key || '').replace(/^claim_drops_/, '');
      if (!pin || !data.claims[pin]) return;
      let parsed = row.value;
      try { parsed = typeof parsed === 'string' ? JSON.parse(parsed) : parsed; } catch (_) {}
      if (parsed && typeof parsed === 'object') {
        if (parsed.drop) data.claims[pin].drop = parsed.drop;
        if (Array.isArray(parsed.drops)) data.claims[pin].drops = parsed.drops;
      }
    });
  } catch (e) { console.warn('claim drops load', e); }
}


async function tryAutoProcessWaivers() {
  if (!window.supabaseClient) return;
  if (!data.waiverDeadline) return;
  if (!waiverDeadlinePassed()) return;
  // Only commissioner session should write (avoids races from every open tab)
  if (!isCommissioner()) return;
  try {
    const { data: row } = await window.supabaseClient
      .from('settings')
      .select('value')
      .eq('key', 'last_processed_deadline')
      .maybeSingle();
    if (row?.value && row.value === data.waiverDeadline) return; // already done
    console.log('Auto-processing waivers for deadline', data.waiverDeadline);
    await processWaivers({ silent: true });
  } catch (e) {
    console.warn('tryAutoProcessWaivers', e);
  }
}

async function processWaivers(opts = {}) {
  const silent = !!opts.silent;
  // Can only process AFTER deadline (claims no longer sealed)
  if (data.waiverDeadline && claimsAreSealed()) {
    if (!silent) {
      alert('Waiver claims are sealed until the deadline. You cannot process before ' + new Date(data.waiverDeadline).toLocaleString() + '.');
    }
    return { ok: false, reason: 'sealed' };
  }
  if (!data.waiverDeadline && !opts.force) {
    if (!silent) alert('Set a waiver deadline first.');
    return { ok: false, reason: 'no_deadline' };
  }

  // Fresh claims from DB (do not trust stale memory)
  await reloadClaimsFromDb();

  const log = document.getElementById('waiver-log');
  if (log) log.innerHTML = '<p class="text-gray-400">Processing...</p>';
  const results = [];

  for (const div of ['east', 'west']) {
    // Worst → first (lowest points first). Tie: stable by pin for determinism
    const order = Object.entries(data.users)
      .filter(([_, u]) => u.division === div && !u.purged)
      .map(([pin, u]) => ({ pin, name: u.name, points: data.points[pin] || 0 }))
      .sort((a, b) => (a.points - b.points) || String(a.pin).localeCompare(String(b.pin)));

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

      // Ranked priority adds + drop POOL.
      // Walk ranked list; each available target uses next unused drop from pool. Max hits = pool size.
      const dropPool = [];
      if (Array.isArray(claim.drops) && claim.drops.length) {
        claim.drops.forEach(d => { if (d) dropPool.push(d); });
      } else if (claim.drop) {
        dropPool.push(claim.drop);
      }
      let poolIdx = 0;
      let hits = 0;
      const u = data.users[team.pin];
      u.roster = u.roster || [];

      for (let ri = 0; ri < claim.ranked.length; ri++) {
        if (poolIdx >= dropPool.length) {
          results.push(`↪️ ${team.name} — no drops left in pool (max ${dropPool.length} pickups)`);
          break;
        }
        const wrestler = claim.ranked[ri];
        const available = getAvailableWrestlers(div);
        if (!availableHas(available, wrestler)) {
          results.push(`↪️ ${team.name} #${ri + 1} ${wrestler} taken — try next`);
          continue;
        }
        const claimName = availableCanonical(available, wrestler);
        // find next drop still on roster
        let drop = null;
        while (poolIdx < dropPool.length) {
          const cand = dropPool[poolIdx++];
          if (rosterHas(u.roster, cand)) { drop = cand; break; }
          results.push(`⚠️ ${team.name} drop ${cand} not on roster — skip drop`);
        }
        if (!drop) {
          results.push(`⚠️ ${team.name} could take ${claimName} but no valid drop left`);
          break;
        }
        u.roster = rosterWithout(u.roster, drop);
        u.roster.push(claimName);
        await saveTeamRoster(team.pin, u.roster);
        hits++;
        results.push(`✅ ${team.name} claimed <strong>${claimName}</strong> (dropped ${drop})`);
      }
      await clearClaim(team.pin);
      if (!hits) {
        results.push(`❌ ${team.name} — no claims filled`);
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

  // Remember this deadline was processed (auto-run won't double-fire)
  try {
    if (data.waiverDeadline) {
      await window.supabaseClient.from('settings').upsert({
        key: 'last_processed_deadline',
        value: data.waiverDeadline
      });
    }
  } catch (e) {}

  renderStandings();
  renderWaiver();
  return { ok: true, results };
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
  const u = data.users[currentUser];
  if (!u) {
    console.error('enterApp: no user for', currentUser, Object.keys(data.users || {}));
    document.getElementById('login-screen')?.classList.remove('hidden');
    document.getElementById('app')?.classList.add('hidden');
    const err = document.getElementById('login-error');
    if (err) {
      err.textContent = 'PIN session lost. Try again.';
      err.classList.remove('hidden');
    }
    return;
  }
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const badge = (u.name || currentUser) + (u.isCommissioner ? ' ⭐' : '') + (isReadOnlyViewer() ? ' (view only)' : '');
  document.getElementById('user-badge').textContent = badge;

  if (canViewCommissionerTools()) {
    document.getElementById('commish-nav')?.classList.remove('hidden');
    document.getElementById('broadcast-nav')?.classList.remove('hidden');
  } else {
    document.getElementById('commish-nav')?.classList.add('hidden');
    document.getElementById('broadcast-nav')?.classList.add('hidden');
  }

  // Disable write controls for observer after paint
  setTimeout(() => applyReadOnlyMode(), 0);
  if (purgeCheckInterval) clearInterval(purgeCheckInterval);
  purgeCheckInterval = setInterval(() => {
    checkAndRunScheduledPurge().catch(() => {});
  }, 60000);
  // Check for pending RED ALERTs
  loadPendingBroadcasts();
  let tab = 'standings';
  try { tab = localStorage.getItem('aew_current_tab') || 'standings'; } catch (e) {}
  // Guard restricted tabs
  if ((tab === 'commissioner' || tab === 'broadcast') && !canViewCommissionerTools()) tab = 'standings';
  if (!document.getElementById('tab-' + tab)) tab = 'standings';
  showTab(tab);
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
                <span class="min-w-0">
                  <span class="font-semibold" title="Owner: ${teamOwnerLabel(pin)}">${teamDisplayName(pin)}</span>
                  ${teamDisplayName(pin) !== teamOwnerLabel(pin) ? `<span class="block text-[10px] text-gray-500" title="Owner: ${teamOwnerLabel(pin)}">${teamOwnerLabel(pin)}</span>` : ''}
                </span>
                <span class="text-sm text-gray-400">${(u.roster || []).length}/${u.maxRoster} • ${data.points[pin] || 0} pts</span>
              </div>
              <div class="flex flex-wrap gap-1.5">
                ${(u.roster || []).slice().sort((a, b) => getWrestlerPts(b) - getWrestlerPts(a) || a.localeCompare(b)).map(w => {
                  const label = championLabel(w);
                  const gold = label ? 'text-aew-gold border-aew-gold/50 font-semibold' : 'border-gray-700';
                  const badge = label ? ` <span class="text-[9px] opacity-80">${label}</span>` : '';
                  const pts = getWrestlerPts(w);
                  const blocked = isOnTradeBlock(pin, w);
                  return `<span class="text-xs bg-black/60 border rounded pl-1 pr-2 py-1 ${gold} inline-flex items-center gap-1.5 relative">
                    ${portraitHtml(w, 'h-20 w-20')}
                    <span>${w}${badge}</span>
                    <span class="text-gray-500">${pts}</span>
                    ${blocked ? '<span class="absolute bottom-0.5 right-0.5 text-sm leading-none" title="On trade block">🤝</span>' : ''}
                  </span>`;
                }).join('') || '<span class="text-gray-500 text-sm">Empty roster</span>'}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  };

  el.innerHTML = `
    <div class="mb-4 p-3 bg-aew-card rounded-xl border border-gray-800 text-sm text-gray-300">
      <span class="text-base">🤝</span> = wrestler is on the <strong class="text-white">trade block</strong> (owner is open to trading them). Set this on <strong class="text-white">My Team</strong>.
    </div>
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
  if (isReadOnlyViewer && isReadOnlyViewer()) { alert('View only'); return; }
  const trade = (data.pendingTrades || []).find(t => String(t.id) === String(tradeId));
  if (!trade) {
    alert('Trade not found (may have already been resolved). Refresh and try again.');
    return;
  }

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
    await notifyTradeUpdate(trade.from_pin, `RED ALERT: ${toName} DECLINED your trade offer.\n${offerDesc}`);
  }

  await loadTrades();
  renderLeagueRosters();
  updateTradeBanner();
  alert(isCommish ? 'Trade vetoed. Both sides have been notified.' : 'Trade declined. The other player has been notified.');
}


function closeTradeOverlay() {
  document.getElementById('trade-overlay')?.remove();
}

function showCounterTradeModal(tradeId) {
  if (typeof isReadOnlyViewer === 'function' && isReadOnlyViewer()) {
    alert('View only');
    return;
  }
  const trade = (data.pendingTrades || []).find(t => String(t.id) === String(tradeId));
  if (!trade) {
    alert('Trade not found');
    return;
  }
  if (trade.to_pin !== currentUser) {
    alert('Only the receiving team can counter this offer.');
    return;
  }

  const originPin = trade.from_pin;
  const origin = data.users[originPin];
  const me = data.users[currentUser];
  if (!origin || !me) return;

  const myRoster = me.roster || [];
  const theirRoster = origin.roster || [];

  closeTradeOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'trade-overlay';
  overlay.className = 'fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-aew-card border border-gray-700 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5">
      <h3 class="text-lg font-bold text-aew-gold mb-1">Counter Trade</h3>
      <p class="text-sm text-gray-400 mb-4">Original offer from <strong class="text-white">${origin.name}</strong> is declined and replaced by your counter.</p>
      <div class="grid sm:grid-cols-2 gap-4 mb-4">
        <div>
          <p class="text-sm font-semibold mb-2">You give (your roster)</p>
          <div class="space-y-1 max-h-48 overflow-y-auto" id="counter-my-list">
            ${myRoster.map(w => `
              <label class="flex items-center gap-2 text-sm bg-black/40 rounded px-2 py-1.5 cursor-pointer">
                <input type="checkbox" class="counter-give" value="${w.replace(/"/g, '&quot;')}" />
                <span>${w}</span>
              </label>`).join('') || '<p class="text-gray-500 text-sm">Empty roster</p>'}
          </div>
        </div>
        <div>
          <p class="text-sm font-semibold mb-2">You want (from ${origin.name})</p>
          <div class="space-y-1 max-h-48 overflow-y-auto" id="counter-their-list">
            ${theirRoster.map(w => `
              <label class="flex items-center gap-2 text-sm bg-black/40 rounded px-2 py-1.5 cursor-pointer">
                <input type="checkbox" class="counter-want" value="${w.replace(/"/g, '&quot;')}" />
                <span>${w}</span>
              </label>`).join('') || '<p class="text-gray-500 text-sm">Empty roster</p>'}
          </div>
        </div>
      </div>
      <div class="flex gap-2 justify-end">
        <button type="button" id="counter-cancel" class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm">Cancel</button>
        <button type="button" id="counter-submit" class="bg-aew-gold text-black font-bold px-4 py-2 rounded-lg text-sm">Send Counter</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#counter-cancel').onclick = closeTradeOverlay;
  overlay.onclick = (e) => { if (e.target === overlay) closeTradeOverlay(); };
  overlay.querySelector('#counter-submit').onclick = async () => {
    const giving = [...overlay.querySelectorAll('.counter-give:checked')].map(el => el.value);
    const wanting = [...overlay.querySelectorAll('.counter-want:checked')].map(el => el.value);
    if (!giving.length || !wanting.length) {
      alert('Select at least one wrestler on each side.');
      return;
    }
    await submitCounterTrade(tradeId, originPin, giving, wanting);
  };
}

async function submitCounterTrade(originalTradeId, originPin, giving, wanting) {
  // Close original as countered, notify, open new offer the other way
  try {
    await window.supabaseClient.from('trades')
      .update({ status: 'countered', resolved_at: new Date().toISOString() })
      .eq('id', originalTradeId);

    const { error } = await window.supabaseClient.from('trades').insert({
      from_pin: currentUser,
      to_pin: originPin,
      offering: giving,
      requesting: wanting,
      status: 'pending'
    });
    if (error) throw error;

    const myName = data.users[currentUser]?.name || currentUser;
    const desc = `Counter — they offer: ${giving.join(', ')} | they want: ${wanting.join(', ')}`;
    await notifyTradeUpdate(
      originPin,
      `RED ALERT: ${myName} COUNTERED your trade.\nYour original offer is closed.\nNew offer: ${desc}`
    );

    closeTradeOverlay();
    await loadTrades();
    renderLeagueRosters();
    updateTradeBanner();
    alert('Counter sent. The other team has been notified.');
  } catch (e) {
    alert('Counter failed: ' + (e.message || e));
  }
}

window.resolveTrade = resolveTrade;
window.showCounterTradeModal = showCounterTradeModal;

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
      const tid = String(t.id).replace(/'/g, "\\'");
      if (isCommish && waitingForCommish) {
        buttons = `
          <button type="button" onclick="resolveTrade('${tid}', true)" class="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold px-4 py-1.5 rounded-lg">Approve Trade</button>
          <button type="button" onclick="resolveTrade('${tid}', false)" class="bg-red-700 hover:bg-red-600 text-white text-sm px-4 py-1.5 rounded-lg">Veto</button>`;
      } else if (!waitingForCommish && t.to_pin === currentUser) {
        buttons = `
          <button type="button" onclick="resolveTrade('${tid}', true)" class="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold px-4 py-1.5 rounded-lg">Accept</button>
          <button type="button" onclick="resolveTrade('${tid}', false)" class="bg-gray-700 hover:bg-gray-600 text-white text-sm px-4 py-1.5 rounded-lg">Decline</button>
          <button type="button" onclick="showCounterTradeModal('${tid}')" class="bg-aew-gold text-black text-sm font-bold px-4 py-1.5 rounded-lg">Counter</button>`;
      } else if (waitingForCommish) {
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
                ${(u.roster || []).slice().sort((a, b) => getWrestlerPts(b) - getWrestlerPts(a) || a.localeCompare(b)).map(w => {
                  const label = championLabel(w);
                  const gold = label ? 'text-aew-gold border-aew-gold/50 font-semibold' : 'border-gray-700';
                  const badge = label ? ` <span class="text-[9px] opacity-80">${label}</span>` : '';
                  const pts = getWrestlerPts(w);
                  const blocked = isOnTradeBlock(pin, w);
                  return `<span class="text-xs bg-black/60 border rounded pl-1 pr-2 py-1 ${gold} inline-flex items-center gap-1.5 relative">
                    ${portraitHtml(w, 'h-20 w-20')}
                    <span>${w}${badge}</span>
                    <span class="text-gray-500">${pts}</span>
                    ${blocked ? '<span class="absolute bottom-0.5 right-0.5 text-sm leading-none" title="On trade block">🤝</span>' : ''}
                  </span>`;
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
  await loadPortraits();
  await loadFantasyChampion();
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
  populateEditRosterSelect();
  renderFantasyChampSelect();
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
  if (guardReadOnly('save an autopick list')) return;
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

async function randomizeDivisions() {
  if (guardReadOnly('randomize divisions')) return;
  const n = Math.max(2, Math.min(8, parseInt(document.getElementById('div-rand-count')?.value, 10) || 2));
  let names = (document.getElementById('div-rand-names')?.value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  while (names.length < n) names.push('Division ' + (names.length + 1));
  names = names.slice(0, n);
  // slugs compatible with existing east/west
  const slugs = names.map((nm, i) => {
    const s = nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || ('div' + (i + 1));
    if (s === 'east_coast' || s === 'east') return 'east';
    if (s === 'west_coast' || s === 'west') return 'west';
    return s;
  });

  const teams = Object.entries(data.users).filter(([pin, u]) => pin && pin !== 'doublej');
  if (teams.length < n) {
    alert('Need at least as many teams as divisions.');
    return;
  }
  // Fisher-Yates
  for (let i = teams.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [teams[i], teams[j]] = [teams[j], teams[i]];
  }
  const buckets = slugs.map((slug, i) => ({ slug, name: names[i], pins: [] }));
  teams.forEach((t, i) => buckets[i % n].pins.push(t[0]));

  const lines = buckets.map(b =>
    b.name + ' (' + b.slug + '): ' + b.pins.map(p => data.users[p]?.name || p).join(', ')
  );
  if (!confirm('Assign divisions like this?\n\n' + lines.join('\n\n'))) return;

  const msg = document.getElementById('div-rand-msg');
  try {
    for (const b of buckets) {
      for (const pin of b.pins) {
        const { error } = await window.supabaseClient.from('teams').update({ division: b.slug }).eq('pin', pin);
        if (error) throw error;
        if (data.users[pin]) data.users[pin].division = b.slug;
      }
    }
    await window.supabaseClient.from('settings').upsert({
      key: 'division_names',
      value: JSON.stringify(buckets.map(b => ({ slug: b.slug, name: b.name })))
    });
    if (msg) { msg.textContent = 'Divisions saved.'; msg.className = 'text-sm text-emerald-400'; }
    renderStandings();
    alert('Divisions randomized and saved.\n\n' + lines.join('\n'));
  } catch (e) {
    if (msg) { msg.textContent = 'Failed: ' + (e.message || e); msg.className = 'text-sm text-red-400'; }
    alert('Could not save divisions: ' + (e.message || e));
  }
}

async function heartbeatDraftPresence() {
  if (!currentUser || !window.supabaseClient) return;
  try {
    await window.supabaseClient.from('settings').upsert({
      key: 'draft_present_' + currentUser,
      value: new Date().toISOString()
    });
  } catch (_) {}
}

async function isDraftOwnerPresent(pin) {
  if (!pin) return false;
  if (pin === currentUser) return true;
  try {
    const { data: row } = await window.supabaseClient
      .from('settings')
      .select('value')
      .eq('key', 'draft_present_' + pin)
      .maybeSingle();
    if (!row?.value) return false;
    const t = new Date(row.value).getTime();
    if (isNaN(t)) return false;
    return Date.now() - t < 90000; // present if heartbeat in last 90s
  } catch (_) {
    return false;
  }
}

async function tryAutoLockDraftOrders() {
  // Server cron (lock-draft-order) owns this. Client never writes order_pins.
  if (!window.supabaseClient) return;
  if (isReadOnlyViewer()) return;
  for (const div of getLeagueDivisions()) {
    try {
      const { data: draft } = await window.supabaseClient.from('drafts').select('*').eq('division', div).maybeSingle();
      if (!draft?.scheduled_at) continue;
      if (draft.status === 'active' || draft.status === 'complete') continue;
      const when = new Date(draft.scheduled_at).getTime();
      if (isNaN(when)) continue;
      const lockAt = when - 15 * 60 * 1000;
      if (Date.now() < lockAt) continue;
      if (draft.order_locked || (draft.order_pins && draft.order_pins.length)) continue;
      // Do not shuffle in the browser. Edge Function lock-draft-order must run.
      console.log('Order not locked yet for', div, '— waiting on server job');
    } catch (e) {
      console.warn('tryAutoLockDraftOrders', div, e);
    }
  }
}

async function tryAbsentAutopicks() {
  if (!window.supabaseClient) return;
  if (isReadOnlyViewer()) return;
  if (typeof isCommissioner === 'function' && !isCommissioner()) return;
  for (const div of getLeagueDivisions()) {
    try {
      const { draft } = await loadDraftState(div);
      if (!draft || draft.status !== 'active') continue;
      const pin = getSnakePin(draft.order_pins || [], draft.current_pick || 0);
      if (!pin) continue;
      const present = await isDraftOwnerPresent(pin);
      if (present) continue; // owner is in the room — wait for them
      await tryAutopick(div);
    } catch (e) {
      console.warn('tryAbsentAutopicks', div, e);
    }
  }
}



function getLeagueDivisions() {
  const fromTeams = new Set();
  Object.values(data.users || {}).forEach(u => {
    if (u && u.division) fromTeams.add(String(u.division).toLowerCase());
  });
  let named = [];
  try {
    const raw = data.settings && (data.settings.division_names || data.settings['division_names']);
    // settings may not be on data.settings — ignore
  } catch (_) {}
  const slugs = [...fromTeams];
  if (!slugs.length) slugs.push('east', 'west');
  slugs.sort();
  return slugs;
}

function divisionLabel(slug) {
  if (!slug) return '';
  const s = String(slug).toLowerCase();
  if (s === 'east') return 'East';
  if (s === 'west') return 'West';
  return String(slug).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fillDraftDivisionSelect() {
  const sel = document.getElementById('draft-div-select');
  if (!sel) return;
  const slugs = getLeagueDivisions();
  const cur = sel.value;
  sel.innerHTML = slugs.map(s => `<option value="${s}">${divisionLabel(s)}</option>`).join('');
  if (slugs.includes(cur)) sel.value = cur;
}


function draftFightStorageKey(div) {
  return 'draft_fight_url_' + String(div || 'east').toLowerCase();
}

async function loadDraftFightUrl(div) {
  try {
    const { data: row } = await window.supabaseClient
      .from('settings')
      .select('value')
      .eq('key', draftFightStorageKey(div))
      .maybeSingle();
    return (row && row.value) ? String(row.value).trim() : '';
  } catch (_) {
    return '';
  }
}

function applyDraftFightFrame(url) {
  const frame = document.getElementById('draft-fight-frame');
  const open = document.getElementById('draft-fight-open');
  const input = document.getElementById('draft-fight-url');
  const src = url || 'https://www.draftfight.com/create-battle';
  if (frame && frame.getAttribute('src') !== src) frame.src = src;
  if (open) open.href = src;
  if (input && url) input.value = url;
}

async function saveDraftFightUrl() {
  if (guardReadOnly('save a Draft Fight link')) return;
  if (typeof isCommissioner === 'function' && !isCommissioner()) return;
  const div = document.getElementById('draft-div-select')?.value || data.users[currentUser]?.division || 'east';
  let url = (document.getElementById('draft-fight-url')?.value || '').trim();
  const msg = document.getElementById('draft-fight-msg');
  if (url && !/^https:\/\/(www\.)?draftfight\.com\//i.test(url)) {
    if (msg) { msg.textContent = 'URL must be a draftfight.com link'; msg.className = 'text-xs mt-1 text-red-400'; }
    return;
  }
  try {
    await window.supabaseClient.from('settings').upsert({
      key: draftFightStorageKey(div),
      value: url || ''
    });
    applyDraftFightFrame(url || 'https://www.draftfight.com/create-battle');
    if (msg) { msg.textContent = url ? 'Saved — everyone in this division will see this fight.' : 'Cleared — default create-battle page.'; msg.className = 'text-xs mt-1 text-emerald-400'; }
  } catch (e) {
    if (msg) { msg.textContent = 'Save failed: ' + (e.message || e); msg.className = 'text-xs mt-1 text-red-400'; }
  }
}

async function renderDraftFightPanel(focusDiv, canSeeAll) {
  const panel = document.getElementById('draft-fight-panel');
  if (!panel) return;
  const commishBox = document.getElementById('draft-fight-commish');
  const isCommish = !!(data.users[currentUser]?.isCommissioner);
  if (commishBox) commishBox.classList.toggle('hidden', !isCommish);
  const url = await loadDraftFightUrl(focusDiv);
  applyDraftFightFrame(url || 'https://www.draftfight.com/create-battle');
}


function isDraftOrderLocked(draft) {
  if (!draft) return false;
  if (draft.order_locked) return true;
  if (!draft.scheduled_at) return false;
  const when = new Date(draft.scheduled_at).getTime();
  if (isNaN(when)) return false;
  return Date.now() >= when - 15 * 60 * 1000 && Array.isArray(draft.order_pins) && draft.order_pins.length > 0;
}

async function generateDraftOrder(division) {
  // Manual shuffle is disabled. Order is created and locked by the server 15 min before start.
  alert('Draft order is set automatically 15 minutes before the scheduled start. Nobody — including the commissioner — can set or change it.');
}

async function startDraft(division) {
  if (guardReadOnly('start the draft')) return;
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


async function zeroAllWrestlerPoints() {
  if (isReadOnlyViewer()) return;
  // New season: every wrestler starts at 0 after draft(s) finish
  const { error } = await window.supabaseClient
    .from('wrestler_points')
    .update({ points: 0 })
    .neq('name', ''); // all rows
  if (error) {
    // Fallback: update one-by-one
    console.error('Bulk zero failed, trying per-row', error);
    const { data: rows } = await window.supabaseClient.from('wrestler_points').select('name');
    for (const r of rows || []) {
      await window.supabaseClient.from('wrestler_points').update({ points: 0 }).eq('name', r.name);
    }
  }
  // Update local cache
  data.wrestlerPoints = data.wrestlerPoints || {};
  Object.keys(data.wrestlerPoints).forEach(k => { data.wrestlerPoints[k] = 0; });
  // Also zero any roster names not in table yet
  for (const u of Object.values(data.users || {})) {
    for (const w of (u.roster || [])) {
      data.wrestlerPoints[w.toLowerCase().trim()] = 0;
    }
  }
  console.log('All wrestler points reset to 0 for new season');
}

async function maybeResetPointsAfterAllDraftsComplete() {
  try {
    const { data: drafts } = await window.supabaseClient.from('drafts').select('division, status');
    const list = drafts || [];
    // Still running?
    if (list.some(d => d.status === 'active' || d.status === 'paused')) {
      console.log('Another draft still in progress — points not reset yet');
      return false;
    }
    // At least one complete?
    if (!list.some(d => d.status === 'complete')) return false;
    await zeroAllWrestlerPoints();
    return true;
  } catch (e) {
    console.error('maybeResetPointsAfterAllDraftsComplete', e);
    return false;
  }
}

async function makeDraftPick(division, wrestler, isAuto = false) {
  if (guardReadOnly('draft')) return;
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

  // If complete, write final rosters; when ALL division drafts are done, zero scores for new season
  if (done) {
    await finalizeDraftRosters(division);
    const reset = await maybeResetPointsAfterAllDraftsComplete();
    if (reset) {
      alert('All drafts complete. Wrestler points reset to 0 for the new season.');
    }
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
  if (isReadOnlyViewer()) return;
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

  // 1) Uploaded target / autopick list
  for (const name of ranked) {
    const match = available.find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      await makeDraftPick(division, match, true);
      return;
    }
  }
  // 2) No list / nothing left on list → best available by prior-season points
  const bpa = available.slice().sort((a, b) => getDraftPts(b) - getDraftPts(a) || a.localeCompare(b));
  if (bpa.length) {
    await makeDraftPick(division, bpa[0], true);
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

  fillDraftDivisionSelect();

  const slugs = getLeagueDivisions();
  const myDiv = (data.users[currentUser]?.division || slugs[0] || 'east').toLowerCase();
  // Owners + read-only-except-doublej: ONLY their division. Commish / doublej can switch.
  const canSeeAllDrafts = isCommish || isReadOnlyViewer();
  const focusDiv = (canSeeAllDrafts
    ? (document.getElementById('draft-div-select')?.value || myDiv)
    : myDiv).toLowerCase();
  const focus = await loadDraftState(focusDiv);

  // Status bar
  const d = focus.draft;
  if (!d) {
    statusEl.innerHTML = '<p class="text-gray-500 text-sm">No draft data. Commissioner needs to set up the draft.</p>';
  } else {
    const orderNames = (d.order_pins || []).map(p => data.users[p]?.name || p).join(' → ');
    statusEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span class="font-bold">${divisionLabel(focusDiv)} Draft</span>
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
      const available = data.masterRoster.filter(w => !taken.has(w.toLowerCase())).sort((a,b) => getDraftPts(b) - getDraftPts(a) || a.localeCompare(b));

      const canPick = isMyTurn || isCommish;
      pickArea.innerHTML = `
        <div class="text-center mb-3">
          <div class="text-sm text-gray-400">On the clock</div>
          <div class="text-2xl font-bold ${isMyTurn ? 'text-aew-gold' : ''}">${name}${isMyTurn ? ' (you)' : ''}</div>
        </div>
        ${canPick ? `
          <div id="draft-drop-zone" class="mb-3 rounded-xl border-2 border-dashed border-aew-gold/50 bg-black/40 px-4 py-4 text-center">
            <div class="text-xs text-gray-400 mb-1">Selected pick</div>
            <div id="draft-selected-label" class="text-lg font-bold text-white min-h-[1.75rem]">Tap a wrestler below (or drag here on desktop)</div>
            <button type="button" id="draft-submit-pick" class="mt-3 w-full sm:w-auto bg-aew-gold text-black font-bold px-8 py-3 rounded-lg text-base disabled:opacity-40 disabled:cursor-not-allowed" disabled>Submit Pick</button>
          </div>
          <input id="draft-pool-filter" type="search" placeholder="Search pool…" class="w-full mb-2 bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm" />
          <div id="draft-pool-grid" class="max-h-80 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            ${available.slice(0, 200).map(w => `
              <div class="draft-pick-btn text-left text-sm px-2 py-2 rounded bg-black/50 hover:bg-gray-800 border border-gray-800 flex items-center gap-2 cursor-pointer" draggable="true" data-name="${String(w).replace(/"/g, '&quot;')}">
                ${portraitHtml(w, 'h-14 w-14')}
                <span class="truncate flex-1">${w}</span>
                <span class="text-gray-500 font-mono text-xs">${getDraftPts(w)}</span>
              </div>
            `).join('')}
          </div>
          ${isCommish && !isMyTurn ? `<button type="button" id="draft-autopick-btn" class="w-full bg-gray-700 hover:bg-gray-600 py-2 rounded-lg text-sm">Force Autopick for ${name}</button>` : ''}
        ` : `<p class="text-center text-gray-500 text-sm">Waiting for ${name} to pick. You can still review the board below.</p>`}
      `;

      if (canPick) {
        let selected = '';
        const label = document.getElementById('draft-selected-label');
        const submit = document.getElementById('draft-submit-pick');
        const zone = document.getElementById('draft-drop-zone');
        const selectWrestler = (w) => {
          selected = w;
          if (label) label.textContent = w;
          if (submit) submit.disabled = !w;
          pickArea.querySelectorAll('.draft-pick-btn').forEach(el => {
            el.classList.toggle('border-aew-gold', el.dataset.name === w);
            el.classList.toggle('bg-aew-gold/10', el.dataset.name === w);
          });
        };
        const commitPick = () => {
          if (!selected) return;
          if (!confirm('Submit pick: ' + selected + '?')) return;
          makeDraftPick(focusDiv, selected, false);
        };
        pickArea.querySelectorAll('.draft-pick-btn').forEach(btn => {
          btn.addEventListener('click', () => selectWrestler(btn.dataset.name));
          btn.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', btn.dataset.name);
          });
        });
        if (zone) {
          zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('border-white'); });
          zone.addEventListener('dragleave', () => zone.classList.remove('border-white'));
          zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('border-white');
            const w = e.dataTransfer.getData('text/plain');
            if (w) selectWrestler(w);
          });
        }
        submit?.addEventListener('click', commitPick);
        const filter = document.getElementById('draft-pool-filter');
        filter?.addEventListener('input', () => {
          const q = (filter.value || '').toLowerCase();
          pickArea.querySelectorAll('.draft-pick-btn').forEach(el => {
            const n = (el.dataset.name || '').toLowerCase();
            el.style.display = !q || n.includes(q) ? '' : 'none';
          });
        });
        document.getElementById('draft-autopick-btn')?.addEventListener('click', () => tryAutopick(focusDiv));
      }
    } else if (d?.status === 'complete') {
      pickArea.innerHTML = '<div class="text-center text-emerald-400 py-4 font-semibold">Draft complete</div>';
    } else {
      const takenPrep = new Set((focus.picks || []).map(p => (p.wrestler || '').toLowerCase()));
      const pool = (data.masterRoster || []).filter(w => !takenPrep.has(w.toLowerCase()))
        .sort((a,b) => getDraftPts(b) - getDraftPts(a) || a.localeCompare(b));
      const orderReady = d?.order_pins?.length;
      const when = d?.scheduled_at ? new Date(d.scheduled_at) : null;
      pickArea.innerHTML = `
        <div class="text-center mb-4">
          <div class="text-lg font-bold">${divisionLabel(focusDiv)} — draft not started</div>
          <div class="text-sm text-amber-400 mt-2">Picks unlock after the commissioner hits <strong>Start Draft</strong>. Then tap a wrestler and Submit Pick.</div>
          ${when && !isNaN(when) ? `<div class="text-sm text-blue-300 mt-1">Starts ${when.toLocaleString()}</div>` : '<div class="text-sm text-gray-500 mt-1">Waiting for commissioner to schedule this draft</div>'}
          ${orderReady
            ? `<div class="text-xs text-gray-400 mt-2">Order locked: ${(d.order_pins || []).map(p => data.users[p]?.name || p).join(' → ')}</div>`
            : `<div class="text-xs text-gray-500 mt-2">Draft order randomizes and locks 15 minutes before start.</div>`}
        </div>
        <div class="text-xs text-gray-400 mb-2">Draft pool (highest prior-season points first) — prepare your board</div>
        <div class="max-h-64 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${pool.slice(0, 80).map(w => `
            <div class="text-left text-sm px-2 py-2 rounded bg-black/50 border border-gray-800 flex items-center gap-2">
              ${portraitHtml(w, 'h-12 w-12')}
              <span class="truncate flex-1">${w}</span>
              <span class="text-gray-500 font-mono text-xs">${getDraftPts(w)}</span>
            </div>
          `).join('') || '<p class="text-gray-500 text-sm">No pool uploaded yet</p>'}
        </div>
      `;
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
          <span class="text-gray-400 w-12">R${p.round}</span>
          <span class="font-medium w-20 truncate">${data.users[p.pin]?.name || p.pin}</span>
          ${p.wrestler ? portraitHtml(p.wrestler, 'h-12 w-12') : ''}
          <span class="${p.is_auto ? 'text-gray-400 italic' : 'text-white'} truncate">${p.wrestler || '—'}${p.is_auto ? ' (auto)' : ''}</span>
        </div>
      `).join('');
    }
  }

  try { await renderDraftFightPanel(focusDiv, canSeeAllDrafts); } catch (e) { console.warn('draft fight', e); }

  // Load user's autopick into textarea
  const ta = document.getElementById('autopick-list');
  if (ta && currentUser) {
    const ranked = await loadAutopick(currentUser);
    if (!ta.value) ta.value = ranked.join('\n');
  }
  await renderAllAutopicks();
}



async function setDraftSchedule() {
  if (guardReadOnly('schedule the draft')) return;
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
    // Try with prior_points; fall back if column missing
    let rows = null, error = null;
    let res = await window.supabaseClient.from('wrestler_points').select('name, points, prior_points');
    if (res.error && String(res.error.message || '').toLowerCase().includes('prior_points')) {
      res = await window.supabaseClient.from('wrestler_points').select('name, points');
    }
    rows = res.data; error = res.error;
    if (error) {
      console.error('Wrestler points load error (keeping previous values):', error);
      if (!data.wrestlerPoints) data.wrestlerPoints = {};
      if (!data.priorPoints) data.priorPoints = {};
      return;
    }
    const next = {};
    const prior = {};
    (rows || []).forEach(r => {
      if (!r || !r.name) return;
      const k = String(r.name).toLowerCase().trim();
      next[k] = Number(r.points) || 0;
      prior[k] = Number(r.prior_points) || 0;
    });
    data.wrestlerPoints = next;
    data.priorPoints = prior;
    console.log('Wrestler points loaded:', Object.keys(data.wrestlerPoints).length, 'prior:', Object.keys(data.priorPoints).filter(k => data.priorPoints[k]).length);
  } catch (e) {
    console.error('Wrestler points load exception (keeping previous values):', e);
    if (!data.wrestlerPoints) data.wrestlerPoints = {};
    if (!data.priorPoints) data.priorPoints = {};
  }
}

function getPriorPts(name) {
  if (!data.priorPoints) return 0;
  return data.priorPoints[name.toLowerCase().trim()] ?? 0;
}

/** Points shown in Draft room: prior season if set, else current season total */
function getDraftPts(name) {
  const p = getPriorPts(name);
  if (p) return p;
  return getWrestlerPts(name);
}

async function savePriorPointsBulk(updates) {
  if (guardReadOnly('update points')) return { ok: false, error: 'View only', saved: 0 };
  // updates = [{name, prior_points}]
  const rows = [];
  const seen = new Map();
  for (const u of updates) {
    const name = (u.name || '').trim();
    if (!name) continue;
    const pts = parseInt(u.prior_points, 10);
    if (isNaN(pts)) continue;
    seen.set(name.toLowerCase(), { name, prior_points: pts, updated_at: new Date().toISOString() });
  }
  for (const row of seen.values()) rows.push(row);
  if (!rows.length) return { ok: false, error: 'No valid lines', saved: 0 };

  // Match existing name casing; keep current season points intact
  try {
    const { data: existing } = await window.supabaseClient.from('wrestler_points').select('name, points');
    const byLower = {};
    (existing || []).forEach(r => { byLower[r.name.toLowerCase().trim()] = r; });
    rows.forEach(r => {
      const ex = byLower[r.name.toLowerCase()];
      if (ex) {
        r.name = ex.name;
        r.points = ex.points; // preserve live season points on upsert
      } else {
        r.points = 0;
      }
    });
  } catch (e) {}

  const { error } = await window.supabaseClient.from('wrestler_points').upsert(rows, { onConflict: 'name' });
  if (error) {
    // Column may not exist yet
    return { ok: false, error: error.message, saved: 0 };
  }
  rows.forEach(r => {
    data.priorPoints = data.priorPoints || {};
    data.priorPoints[r.name.toLowerCase().trim()] = r.prior_points;
  });
  return { ok: true, saved: rows.length };
}

function getWrestlerPts(name) {
  if (!data.wrestlerPoints) return 0;
  return data.wrestlerPoints[name.toLowerCase().trim()] ?? 0;
}

async function saveWrestlerPointsBulk(updates) {
  // updates = [{name, points}, ...]
  // Normalize: trim names, batch upsert with explicit conflict target
  const rows = [];
  const seen = new Map(); // lowercase -> final row (last wins)
  for (const u of updates) {
    const name = (u.name || '').trim();
    if (!name) continue;
    const pts = parseInt(u.points, 10);
    if (isNaN(pts)) continue;
    seen.set(name.toLowerCase(), { name, points: pts, updated_at: new Date().toISOString() });
  }
  for (const row of seen.values()) rows.push(row);
  if (!rows.length) return { ok: false, error: 'No valid updates', saved: 0 };

  // Prefer matching existing DB casing so we don't create duplicate keys
  const existingByLower = {};
  try {
    const { data: existing } = await window.supabaseClient.from('wrestler_points').select('name');
    (existing || []).forEach(r => {
      existingByLower[r.name.toLowerCase().trim()] = r.name;
    });
  } catch (e) {}

  rows.forEach(r => {
    const canon = existingByLower[r.name.toLowerCase()];
    if (canon) r.name = canon;
  });

  const { error } = await window.supabaseClient
    .from('wrestler_points')
    .upsert(rows, { onConflict: 'name' });

  if (error) {
    console.error('Bulk wrestler points error:', error);
    // Fallback: one-by-one so partial success still works
    let saved = 0;
    const failed = [];
    for (const r of rows) {
      const { error: e2 } = await window.supabaseClient
        .from('wrestler_points')
        .upsert(r, { onConflict: 'name' });
      if (e2) {
        failed.push(r.name + ': ' + e2.message);
      } else {
        data.wrestlerPoints[r.name.toLowerCase().trim()] = r.points;
        saved++;
      }
    }
    return { ok: failed.length === 0, error: failed.join('; '), saved, total: rows.length };
  }

  rows.forEach(r => {
    data.wrestlerPoints[r.name.toLowerCase().trim()] = r.points;
  });
  return { ok: true, saved: rows.length, total: rows.length };
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



async function softRefreshAfterImportHook() {
  try {
    if (isCommissioner()) await tryAutoBuildDraftForDueShows();
  } catch (e) { console.warn(e); }
}
async function softRefresh(showToast = false) {
  if (!currentUser) return;
  try {
    await loadAllData();
    if (isReadOnlyViewer()) setTimeout(() => applyReadOnlyMode(), 0);
  if (purgeCheckInterval) clearInterval(purgeCheckInterval);
  purgeCheckInterval = setInterval(() => {
    checkAndRunScheduledPurge().catch(() => {});
  }, 60000);
    // Re-render the current visible tab
    const active = document.querySelector('.nav-btn.active');
    const tab = active?.dataset?.tab || 'standings';
    if (tab === 'standings') renderStandings();
    else if (tab === 'calendar') renderCalendar();
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

  const byDiv = { east: [], west: [] };
  Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([pin, u]) => {
      if (u.division === 'east') byDiv.east.push([pin, u]);
      else if (u.division === 'west') byDiv.west.push([pin, u]);
    });

  const row = ([pin, u]) => {
    const cur = data.points[pin] || 0;
    return `
    <div class="flex items-center gap-2 flex-wrap py-1">
      <span class="text-sm w-28 font-medium" title="Owner: ${teamOwnerLabel(pin)}">${teamDisplayName(pin)}</span>
      <span class="text-xs text-gray-500">Now: <span class="text-white font-mono">${cur}</span></span>
      <input type="number" data-pin="${pin}" data-current="${cur}" class="score-add-input w-28 bg-black border border-gray-700 rounded-lg px-2 py-1.5 text-sm" placeholder="New total" />
    </div>`;
  };

  el.innerHTML = `
    <p class="text-xs text-gray-400 mb-3 md:col-span-2">Enter <strong>new season totals</strong> for every team that scored (East <em>and</em> West), then click <strong>Save Scores</strong> once. Blank = unchanged. Do not save one division at a time.</p>
    <div class="grid md:grid-cols-2 gap-6">
      <div>
        <h4 class="text-sm font-bold text-blue-400 mb-2">East</h4>
        ${byDiv.east.map(row).join('') || '<p class="text-gray-500 text-sm">No teams</p>'}
      </div>
      <div>
        <h4 class="text-sm font-bold text-aew-gold mb-2">West</h4>
        ${byDiv.west.map(row).join('') || '<p class="text-gray-500 text-sm">No teams</p>'}
      </div>
    </div>`;
}

async function saveScores() {
  if (guardReadOnly('update scores')) return;
  const inputs = document.querySelectorAll('.score-add-input');

  // Inputs are NEW TOTALS. Blank = leave that team alone (and leave their last_delta alone).
  // Example: Ford is 203, enter 203 → delta 0 (red 0). Enter 208 → delta +5 (green).
  // CRITICAL: only update teams with a value. Never clear other teams' points or deltas.
  const scored = [];
  for (const input of inputs) {
    const raw = (input.value || '').trim();
    const pin = input.dataset.pin;
    if (!pin || raw === '') continue;
    const newTotal = parseInt(raw, 10);
    if (isNaN(newTotal)) continue;
    if (newTotal < 0) {
      alert('Points cannot be negative for ' + (data.users[pin]?.name || pin));
      return;
    }
    scored.push({ pin, newTotal, name: data.users[pin]?.name || pin });
  }
  if (scored.length === 0) {
    alert('Enter the new total for at least one team.\n\nTip: Fill East AND West, then Save once.');
    return;
  }

  // Reload latest points from DB so deltas are accurate (read-only — does not write)
  try {
    const { data: teams } = await window.supabaseClient.from('teams').select('pin, points, last_delta');
    (teams || []).forEach(t => {
      data.points[t.pin] = t.points || 0;
      if (data.users[t.pin]) data.users[t.pin].lastDelta = t.last_delta;
    });
  } catch (e) {
    console.error('Could not refresh points before save', e);
  }

  // Build preview with deltas
  const lines = scored.map(({ pin, newTotal, name }) => {
    const current = data.points[pin] || 0;
    const delta = newTotal - current;
    const dStr = delta > 0 ? '+' + delta : String(delta);
    return name + ': ' + current + ' → ' + newTotal + ' (' + dStr + ')';
  });
  if (!confirm('Save these totals?\n\n' + lines.join('\n') + '\n\nTeams left blank will not be changed.')) {
    return;
  }

  // Guard: warn if any total drops a lot (likely typo)
  const bigDrop = scored.filter(({ pin, newTotal }) => {
    const current = data.points[pin] || 0;
    return current > 0 && newTotal < current - 20;
  });
  if (bigDrop.length) {
    const names = bigDrop.map(s => s.name + ' (' + (data.points[s.pin]||0) + '→' + s.newTotal + ')').join(', ');
    if (!confirm('WARNING: large score drop for: ' + names + '\n\nContinue anyway?')) return;
  }

  const results = await Promise.all(scored.map(async ({ pin, newTotal }) => {
    const current = data.points[pin] || 0;
    const delta = newTotal - current;
    try {
      await saveTeamPoints(pin, newTotal, delta);
      return { pin, ok: true };
    } catch (e) {
      console.error('save failed', pin, e);
      return { pin, ok: false, error: e.message || String(e) };
    }
  }));

  const failed = results.filter(r => !r.ok);
  const okCount = results.filter(r => r.ok).length;

  // Clear only the inputs we used (not related to DB)
  for (const input of inputs) input.value = '';

  renderScoreInputs();
  populateEditRosterSelect();
  renderFantasyChampSelect();
  renderWaiverReports();
  renderStandings();

  if (failed.length) {
    alert('Saved ' + okCount + ' team(s), but FAILED for: ' + failed.map(f => data.users[f.pin]?.name || f.pin).join(', ') + '\nPoints for failed teams were NOT changed.');
  } else {
    alert('Saved points for ' + okCount + ' team(s) (East + West in one save). Standings updated.');
  }
}

// Also allow setting absolute total (optional helper)
async function setAbsoluteTeamPoints(pin, total) {
  await saveTeamPoints(pin, total);
  renderScoreInputs();
  populateEditRosterSelect();
  renderFantasyChampSelect();
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




function waiverDeadlinePassed() {
  if (!data.waiverDeadline) return false;
  const d = new Date(data.waiverDeadline);
  if (isNaN(d.getTime())) return false;
  return Date.now() >= d.getTime();
}

function claimsAreSealed() {
  // Sealed = deadline is set AND has not passed yet. Nobody (incl. Devin) sees others' claims.
  if (!data.waiverDeadline) return false; // no deadline → not sealed by time (still private per-user)
  return !waiverDeadlinePassed();
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
    text.textContent = 'Waiver claims due by ' + when + '. Submit before this time. Claims are hidden from all players and the commissioner until the deadline.';
  }
  banner.classList.remove('hidden');
}



function populateEditRosterSelect() {
  const sel = document.getElementById('edit-roster-team');
  if (!sel) return;
  const current = sel.value;
  const teams = Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .sort((a, b) => {
      if (a[1].division !== b[1].division) return a[1].division.localeCompare(b[1].division);
      return a[1].name.localeCompare(b[1].name);
    });
  sel.innerHTML = '<option value="">Select team...</option>' +
    teams.map(([pin, u]) => `<option value="${pin}">${u.name} (${u.division}) — ${(u.roster || []).length}/${u.maxRoster || 8}</option>`).join('');
  if (current) sel.value = current;
}

function loadEditRosterText() {
  const pin = document.getElementById('edit-roster-team')?.value;
  const ta = document.getElementById('edit-roster-text');
  const msg = document.getElementById('edit-roster-msg');
  if (!ta) return;
  if (!pin || !data.users[pin]) {
    ta.value = '';
    return;
  }
  ta.value = (data.users[pin].roster || []).join('\n');
  if (msg) msg.textContent = '';
}

async function saveEditRoster() {
  const pin = document.getElementById('edit-roster-team')?.value;
  const ta = document.getElementById('edit-roster-text');
  const msg = document.getElementById('edit-roster-msg');
  if (!pin || !data.users[pin]) {
    if (msg) { msg.textContent = 'Select a team first'; msg.className = 'text-sm mt-2 text-red-400'; }
    return;
  }
  const roster = (ta?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
  const max = data.users[pin].maxRoster || 8;
  if (roster.length > max) {
    if (!confirm(`This roster has ${roster.length} names but max is ${max}. Save anyway?`)) return;
  }
  await saveTeamRoster(pin, roster);
  data.users[pin].roster = roster;
  if (msg) {
    msg.textContent = `Saved ${data.users[pin].name}: ${roster.length} wrestlers`;
    msg.className = 'text-sm mt-2 text-emerald-400';
  }
  populateEditRosterSelect();
  renderFantasyChampSelect();
  renderStandings();
}



function getFantasyChampionPin() {
  return data.fantasyChampion || null;
}

function isFantasyChampion(pin) {
  return pin && data.fantasyChampion && pin === data.fantasyChampion;
}

function champCrown(pin) {
  return isFantasyChampion(pin) ? ' 👑' : '';
}

async function loadFantasyChampion() {
  try {
    const { data: row } = await window.supabaseClient
      .from('settings')
      .select('value')
      .eq('key', 'fantasy_champion')
      .maybeSingle();
    data.fantasyChampion = row?.value || null;
  } catch (e) {
    console.error('fantasy champion load', e);
    data.fantasyChampion = null;
  }
}

function renderFantasyChampSelect() {
  const sel = document.getElementById('fantasy-champ-select');
  if (!sel) return;
  const teams = Object.entries(data.users)
    .filter(([_, u]) => u.division)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  sel.innerHTML = '<option value="">No champion set</option>' +
    teams.map(([pin, u]) => `<option value="${pin}">${u.name} (${u.division})</option>`).join('');
  if (data.fantasyChampion) sel.value = data.fantasyChampion;
}

async function saveFantasyChampion() {
  const pin = document.getElementById('fantasy-champ-select')?.value || '';
  const msg = document.getElementById('fantasy-champ-msg');
  await window.supabaseClient.from('settings').upsert({
    key: 'fantasy_champion',
    value: pin
  });
  data.fantasyChampion = pin || null;
  if (msg) {
    msg.textContent = pin
      ? `Champion set to ${data.users[pin]?.name || pin}`
      : 'Champion cleared';
    msg.className = 'text-sm mt-2 text-emerald-400';
  }
  renderStandings();
  renderLeagueRosters();
  renderPastChampions();
}



const PAST_CHAMPIONS = [
  { season: 1, name: 'Devin' },
  { season: 2, name: 'Gally' },
  { season: 3, name: 'Stess' },
  { season: 4, name: 'Kamill' },
  { season: 5, name: 'Devin' },
  { season: 6, name: 'Evan' },
  { season: 7, name: 'Bito and Boti tag team' },
  { season: 8, name: 'Josh' },
];

function renderPastChampions() {
  const el = document.getElementById('past-champions-list');
  if (!el) return;

  // Latest past champion in the list is S8 Josh — crown only if they are also the active fantasy champion
  const currentPin = data.fantasyChampion;
  const currentName = currentPin ? (data.users[currentPin]?.name || '') : '';

  el.innerHTML = PAST_CHAMPIONS.slice().reverse().map((c, idx) => {
    // Only show crown on the most recent season entry if that person is the active champion
    const isLatest = c.season === Math.max(...PAST_CHAMPIONS.map(x => x.season));
    const showCrown = isLatest && currentName && currentName.toLowerCase() === c.name.toLowerCase();
    // Also match if champion name is Josh and entry is Josh
    const showCrown2 = isLatest && currentPin && (data.users[currentPin]?.name || '').toLowerCase().includes('josh') && c.name.toLowerCase() === 'josh';
    const crown = (showCrown || showCrown2) ? ' 👑' : '';
    return `
      <div class="flex items-center justify-between px-4 py-3 ${isLatest ? 'bg-aew-gold/5' : ''}">
        <div class="flex items-center gap-3">
          <span class="text-gray-500 text-sm w-16">Season ${c.season}</span>
          <span class="font-semibold ${isLatest ? 'text-aew-gold' : ''}">${c.name}${crown}</span>
        </div>
        ${isLatest ? '<span class="text-xs text-aew-gold">Current</span>' : ''}
      </div>
    `;
  }).join('');
}


let purgeCheckInterval = null;
document.addEventListener('DOMContentLoaded', async () => {

  // ALWAYS show login until enterApp succeeds — hiding it first caused a blank page
  document.getElementById('login-screen')?.classList.remove('hidden');
  document.getElementById('app')?.classList.add('hidden');

  // Bind login FIRST so a failed data load cannot kill the PIN box
  document.getElementById('login-btn')?.addEventListener('click', async () => {
    const err = document.getElementById('login-error');
    const pin = document.getElementById('pin-input').value;
    const res = login(pin);
    if (!res.ok) {
      if (err) { err.textContent = res.error; err.classList.remove('hidden'); }
      return;
    }
    try {
      await loadAllData();
      enterApp();
    } catch (e) {
      console.error('enterApp/loadAllData', e);
      if (err) {
        err.textContent = 'PIN is valid but the app failed to open: ' + (e.message || e);
        err.classList.remove('hidden');
      } else {
        alert('PIN is valid but the app failed to open: ' + (e.message || e));
      }
    }
  });

  document.getElementById('pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn')?.click();
  });

  try {
    await loadAllData();
  } catch (e) {
    console.error('Initial loadAllData', e);
    const err = document.getElementById('login-error');
    if (err) {
      err.textContent = 'Could not load league data: ' + (e.message || e);
      err.classList.remove('hidden');
    }
  }
  const savedPin = (localStorage.getItem('aew_current_pin') || '').trim().toLowerCase();
  if (savedPin && data.users[savedPin]) {
    currentUser = savedPin;
    try { enterApp(); } catch (e) {
      console.error(e);
      document.getElementById('login-screen')?.classList.remove('hidden');
    }
  }


  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.getElementById('refresh-btn')?.addEventListener('click', () => softRefresh(true));
  document.getElementById('save-scores')?.addEventListener('click', saveScores);
  document.getElementById('edit-roster-team')?.addEventListener('change', loadEditRosterText);
  document.getElementById('edit-roster-reload')?.addEventListener('click', loadEditRosterText);
  document.getElementById('edit-roster-save')?.addEventListener('click', saveEditRoster);
  document.getElementById('fantasy-champ-save')?.addEventListener('click', saveFantasyChampion);
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
    const result = await saveWrestlerPointsBulk([{ name, points: pts }]);
    await loadWrestlerPoints();
  await loadPortraits();
    if (msg) {
      if (result.ok) {
        msg.textContent = `Updated ${name} to ${pts} pts`;
        msg.className = 'text-sm text-emerald-400';
      } else {
        msg.textContent = 'Error: ' + (result.error || 'save failed');
        msg.className = 'text-sm text-red-400';
      }
    }
    document.getElementById('wp-name').value = '';
    document.getElementById('wp-points').value = '';
  });

  document.getElementById('wp-bulk-btn')?.addEventListener('click', async () => {
    const text = document.getElementById('wp-bulk')?.value || '';
    const updates = [];
    text.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      const m = line.match(/^(.+)\s+(-?\d+)$/);
      if (m) updates.push({ name: m[1].trim(), points: parseInt(m[2], 10) });
    });
    if (!updates.length) return alert('No valid lines (format: Name 12)');
    const msg = document.getElementById('wp-msg');
    if (msg) { msg.textContent = 'Saving ' + updates.length + ' wrestlers...'; msg.className = 'text-sm text-yellow-400'; }
    const result = await saveWrestlerPointsBulk(updates);
    await loadWrestlerPoints();
  await loadPortraits(); // confirm from DB
    if (msg) {
      if (result.ok) {
        msg.textContent = 'Saved ' + result.saved + ' wrestlers';
        msg.className = 'text-sm text-emerald-400';
      } else {
        msg.textContent = 'Saved ' + (result.saved || 0) + '/' + (result.total || updates.length) + '. ' + (result.error || '');
        msg.className = 'text-sm text-red-400';
      }
    }
  });

  document.getElementById('save-autopick')?.addEventListener('click', saveAutopickList);
  document.getElementById('draft-fight-save')?.addEventListener('click', saveDraftFightUrl);
  
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
      document.getElementById('claim-status').textContent = 'Add at least one wrestler to claim';
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-red-400';
      return;
    }
    if (!claimDrops.filter(Boolean).length) {
      document.getElementById('claim-status').textContent = 'Add at least one drop to your drop pool';
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-red-400';
      return;
    }
    const drops = claimDrops.filter(Boolean);
    const summary = 'PRIORITY ADDS:\n' + claimRanked.map((w,i) => `  ${i+1}. ${w}`).join('\n') +
      '\n\nDROP POOL (' + drops.length + ' max pickups):\n' + drops.map(d => `  • ${d}`).join('\n');
    if (!confirm('Submit waiver claim?\n\n' + summary)) return;
    try {
      await saveClaim(currentUser, [...claimRanked], drops[0], [...drops]);
      document.getElementById('claim-status').textContent = 'SAVED: ' + claimRanked.length + ' ranked / ' + drops.length + ' drops (up to ' + drops.length + ' pickups)';
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-emerald-400';
    } catch (e) {
      console.error(e);
      document.getElementById('claim-status').textContent = 'SAVE FAILED: ' + (e.message || e);
      document.getElementById('claim-status').className = 'text-sm text-center mt-3 text-red-400';
      alert('Claim failed: ' + (e.message || e));
    }
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

  
  document.getElementById('portrait-pack')?.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    const msg = document.getElementById('portrait-pack-msg');
    if (msg) { msg.textContent = 'Uploading ' + files.length + ' images...'; msg.className = 'text-sm text-yellow-400'; }
    let matched = 0, skipped = 0;
    for (const file of files) {
      const base = normalizeImageBasename(file.name);
      const wrestler = findRosterNameForBasename(base);
      if (!wrestler) { skipped++; continue; }
      try {
        const url = await fileToDataUrl(file, 256, 600 * 1024);
        const ok = await savePortraitToDb(wrestler, url);
        if (ok) matched++; else skipped++;
      } catch (err) {
        skipped++;
      }
    }
    if (msg) {
      msg.textContent = 'Matched ' + matched + ' portrait(s).' + (skipped ? ' ' + skipped + ' skipped.' : '');
      msg.className = 'text-sm text-emerald-400';
    }
    renderMyTeam();
    renderWaiver();
    renderLeagueRosters();
  });

  document.getElementById('prior-pts-save')?.addEventListener('click', async () => {
    const text = document.getElementById('prior-pts-bulk')?.value || '';
    const updates = [];
    text.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      const m = line.match(/^(.+)\s+(-?\d+)$/);
      if (m) updates.push({ name: m[1].trim(), prior_points: parseInt(m[2], 10) });
    });
    const msg = document.getElementById('prior-pts-msg');
    if (!updates.length) {
      if (msg) { msg.textContent = 'No valid lines (format: Name 12)'; msg.className = 'text-sm text-red-400'; }
      return;
    }
    if (msg) { msg.textContent = 'Saving...'; msg.className = 'text-sm text-yellow-400'; }
    const result = await savePriorPointsBulk(updates);
    if (msg) {
      if (result.ok) {
        msg.textContent = 'Saved prior-season points for ' + result.saved + ' wrestlers. They appear in the Draft room.';
        msg.className = 'text-sm text-emerald-400';
      } else {
        msg.textContent = 'Error: ' + (result.error || 'failed') + ' — run the prior_points SQL if you have not yet.';
        msg.className = 'text-sm text-red-400';
      }
    }
  });
  
  document.getElementById('season-dates-save')?.addEventListener('click', async () => {
    const start = document.getElementById('season-start-date')?.value || '';
    const end = document.getElementById('season-end-date')?.value || '';
    const msg = document.getElementById('season-dates-msg');
    await saveSeasonDates(start, end);
    if (msg) { msg.textContent = 'Season dates saved'; msg.className = 'text-sm text-emerald-400'; }
    renderSeasonDatesBanner();
  });
  document.getElementById('cal-ev-add')?.addEventListener('click', async () => {
    const name = (document.getElementById('cal-ev-name')?.value || '').trim();
    const event_type = document.getElementById('cal-ev-type')?.value || 'other';
    const event_date = document.getElementById('cal-ev-date')?.value || null;
    const notes = (document.getElementById('cal-ev-notes')?.value || '').trim();
    const msg = document.getElementById('cal-ev-msg');
    const editId = (document.getElementById('cal-ev-id')?.value || '').trim();

    if (!name) {
      if (msg) { msg.textContent = 'Name required'; msg.className = 'text-sm text-red-400'; }
      return;
    }
    if (!event_date && ['weekly_tv', 'special_tv', 'ppv'].includes(event_type)) {
      if (msg) { msg.textContent = 'Date required — pick a date before saving'; msg.className = 'text-sm text-red-400'; }
      return;
    }

    const payload = {
      name,
      event_type: normalizeEventType(event_type),
      frequency: 'once',
      day_of_week: null,
      event_date: event_date || null,
      notes
    };

    try {
      if (msg) { msg.textContent = 'Saving…'; msg.className = 'text-sm text-gray-400'; }
      if (editId) {
        await updateCalendarEvent(editId, payload);
        if (msg) { msg.textContent = 'Event updated'; msg.className = 'text-sm text-emerald-400'; }
      } else {
        await addCalendarEvent(payload);
        if (msg) { msg.textContent = 'Event saved: ' + name; msg.className = 'text-sm text-emerald-400'; }
      }
      clearCalEventForm();
      await loadCalendarEvents();
      renderCalendarAdmin();
      renderCalendar();
    } catch (err) {
      console.error('calendar save failed', err);
      const text = (err && (err.message || err.error_description || err.details)) || String(err);
      if (msg) { msg.textContent = 'Save failed: ' + text; msg.className = 'text-sm text-red-400'; }
      alert('Could not save calendar event:\n' + text);
    }
  });
  document.getElementById('cal-ev-cancel')?.addEventListener('click', () => {
    clearCalEventForm();
    const msg = document.getElementById('cal-ev-msg');
    if (msg) msg.textContent = '';
  });

  
  document.getElementById('wrestler-rename-btn')?.addEventListener('click', async () => {
    const from = document.getElementById('wrestler-rename-from')?.value || '';
    const to = document.getElementById('wrestler-rename-to')?.value || '';
    const msg = document.getElementById('wrestler-rename-msg');
    if (!confirm('Rename "' + from + '" to "' + to + '" everywhere?')) return;
    if (msg) { msg.textContent = 'Working...'; msg.className = 'text-sm text-yellow-400'; }
    const res = await renameWrestlerEverywhere(from, to);
    if (msg) {
      msg.textContent = res.ok ? 'Renamed successfully' : (res.error || 'Failed');
      msg.className = 'text-sm ' + (res.ok ? 'text-emerald-400' : 'text-red-400');
    }
    if (res.ok) {
      document.getElementById('wrestler-rename-from').value = '';
      document.getElementById('wrestler-rename-to').value = '';
      fillWrestlerNameList();
      const upload = document.getElementById('roster-upload');
      if (upload) upload.value = (data.masterRoster || []).join('\\n');
      renderStandings();
      renderMyTeam();
    }
  });
  document.getElementById('wrestler-delete-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('wrestler-delete-name')?.value || '';
    const msg = document.getElementById('wrestler-delete-msg');
    if (!name.trim()) return;
    if (!confirm('Delete "' + name + '" from the league pool, points, and all rosters?')) return;
    if (msg) { msg.textContent = 'Working...'; msg.className = 'text-sm text-yellow-400'; }
    const res = await deleteWrestlerEverywhere(name);
    if (msg) {
      msg.textContent = res.ok ? 'Deleted' : (res.error || 'Failed');
      msg.className = 'text-sm ' + (res.ok ? 'text-emerald-400' : 'text-red-400');
    }
    if (res.ok) {
      document.getElementById('wrestler-delete-name').value = '';
      fillWrestlerNameList();
      const upload = document.getElementById('roster-upload');
      if (upload) upload.value = (data.masterRoster || []).join('\\n');
    }
  });

  // Trade block toggles on My Team
  document.getElementById('my-team-content')?.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'my-team-name-save') {
      const input = document.getElementById('my-team-name-input');
      const msg = document.getElementById('my-team-name-msg');
      const res = await saveTeamName(currentUser, input?.value || '');
      if (msg) {
        msg.textContent = res.ok ? 'Team name saved' : 'Save failed';
        msg.className = 'text-xs ' + (res.ok ? 'text-emerald-400' : 'text-red-400');
      }
      if (res.ok) {
        renderMyTeam();
        renderStandings();
        renderLeagueRosters();
      }
      return;
    }
    const btn = e.target.closest('[data-trade-block]');
    if (!btn) return;
    const w = btn.getAttribute('data-trade-block');
    try {
      await toggleTradeBlock(w);
      renderMyTeam();
      renderLeagueRosters();
    } catch (err) {
      alert('Trade block failed: ' + (err.message || err) + '\nRun trade_blocks SQL if needed.');
    }
  });
  
  document.getElementById('purge-schedule-save')?.addEventListener('click', async () => {
    if (guardReadOnly && guardReadOnly('schedule purge')) return;
    const d = document.getElementById('purge-date')?.value || '';
    const t = document.getElementById('purge-time')?.value || '';
    const n = document.getElementById('purge-notes')?.value || '';
    if (d && !t) {
      alert('Pick a time for the purge, or clear the date to unschedule.');
      return;
    }
    await savePurgeSchedule(d, t, n);
    const msg = document.getElementById('purge-schedule-msg');
    if (msg) {
      msg.textContent = d ? ('Purge auto-scheduled for ' + d + ' ' + t) : 'Purge schedule cleared';
      msg.className = 'text-sm mb-4 text-emerald-400';
    }
    renderStandings();
  });
  document.getElementById('purge-run-btn')?.addEventListener('click', () => runPurgeNow());

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



// ----- Auto draft persistence (settings table — Devin never touches Supabase) -----
async function savePendingShowDraft(draft) {
  if (!window.supabaseClient || !draft) return;
  const payload = {
    meta: draft.meta,
    matches: draft.matches,
    pointsMap: draft.pointsMap,
    playerBonuses: draft.playerBonuses,
    savedAt: new Date().toISOString()
  };
  await window.supabaseClient.from('settings').upsert({
    key: 'pending_show_import',
    value: JSON.stringify(payload)
  });
}

async function clearPendingShowDraft() {
  if (!window.supabaseClient) return;
  await window.supabaseClient.from('settings').delete().eq('key', 'pending_show_import');
}

async function loadPendingShowDraft() {
  if (!window.supabaseClient) return null;
  try {
    const { data: row } = await window.supabaseClient
      .from('settings')
      .select('value')
      .eq('key', 'pending_show_import')
      .maybeSingle();
    if (!row?.value) return null;
    const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    if (!parsed?.matches) return null;
    return parsed;
  } catch (e) {
    console.warn('loadPendingShowDraft', e);
    return null;
  }
}

/** Recompute player tag/rivalry bonuses from CURRENT rosters */
function recomputePlayerBonuses(matches) {
  const playerBonuses = {};
  Object.entries(data.users || {}).forEach(([pin, u]) => {
    if (!u.division || u.purged) return;
    const roster = u.roster || [];
    let total = 0;
    const breakdown = [];
    (matches || []).forEach((match, i) => {
      const sides = match.sides || [match.winners || [], match.losers || []];
      const b = computePlayerMatchBonuses(roster, sides);
      if (b.points > 0) {
        total += b.points;
        breakdown.push(`Match ${i + 1}: ` + b.breakdown.join('; '));
      }
    });
    if (total > 0) playerBonuses[pin] = { points: total, breakdown, name: u.name };
  });
  return playerBonuses;
}

async function promptCommissionerPendingDraft() {
  if (!isCommissioner()) return;
  const pending = await loadPendingShowDraft();
  if (!pending || !pending.matches?.length) return;
  // Edge function may send matches only — score here with hard-coded rules + live rosters
  if (pending.needsClientScore || !pending.pointsMap || !Object.keys(pending.pointsMap).length) {
    const isPpv = !!(pending.meta && pending.meta.isPpv);
    const scored = buildImportDraft(pending.matches, pending.meta || { showLabel: 'Show', isPpv, source: pending.meta?.source || 'auto' });
    pending.pointsMap = scored.pointsMap;
    pending.playerBonuses = scored.playerBonuses;
    pending.meta = scored.meta;
  } else {
    pending.playerBonuses = recomputePlayerBonuses(pending.matches);
  }
  currentShowImport = pending;
  openShowImportModal(pending);
}

/** Calendar shows that should have results (today or yesterday) */
function dueShowsForImport() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  const t = iso(today);
  const y = iso(yesterday);
  return (data.calendarEvents || []).filter(ev => {
    const type = normalizeEventType(ev.event_type);
    if (!['weekly_tv', 'special_tv', 'ppv'].includes(type)) return false;
    const d = String(ev.event_date || '').slice(0, 10);
    return d === t || d === y;
  });
}

async function tryAutoBuildDraftForDueShows() {
  if (!isCommissioner()) return;
  const existing = await loadPendingShowDraft();
  if (existing) {
    await promptCommissionerPendingDraft();
    return;
  }
  const due = dueShowsForImport();
  if (!due.length) return;
  // Try Edge Function if deployed (Ford sets this up once)
  try {
    const sb = window.supabaseClient;
    if (sb?.functions?.invoke) {
      // Supabase slug may be hyper-action (dashboard rename doesn't always change URL)
      let data = null, error = null;
      const payload = { shows: due.map(e => ({ name: e.name, date: e.event_date, type: e.event_type })) };
      ({ data, error } = await sb.functions.invoke('hyper-action', { body: payload }));
      if (error || !data) {
        ({ data, error } = await sb.functions.invoke('fetch-show-results', { body: payload }));
      }
      if (!error && data?.matches?.length) {
        const meta = {
          showLabel: data.showLabel || due[0].name,
          showDate: data.showDate || due[0].event_date,
          isPpv: normalizeEventType(due[0].event_type) === 'ppv',
          source: data.source || 'auto'
        };
        const draft = buildImportDraft(data.matches, meta);
        draft.playerBonuses = recomputePlayerBonuses(draft.matches);
        await savePendingShowDraft(draft);
        openShowImportModal(draft);
        return;
      }
    }
  } catch (e) {
    console.warn('auto fetch edge function', e);
  }
  // No auto results yet — banner on import panel
  const msg = document.getElementById('import-msg');
  if (msg) {
    msg.textContent = 'Due show(s): ' + due.map(e => e.name).join(', ') + ' — paste results below (or wait for auto-fetch). Bonuses use live rosters.';
    msg.className = 'text-sm text-amber-400';
  }
}

// ========== SHOW RESULTS IMPORT ==========
let currentShowImport = null; // { matches, pointsMap, playerBonuses, meta }

function titleTierFromName(titleName) {
  const t = (titleName || '').toLowerCase();
  if (!t) return 'none';
  if (t.includes('world') && !t.includes('trios') && !t.includes('tag')) return 'world';
  if (t.includes('tnt') || t.includes('tbs') || t.includes('international') || t.includes('continental') || t.includes('national') || t.includes('tag') || t.includes('trios')) return 'mid';
  if (t.includes('roh') || t.includes('njpw') || t.includes('iwgp') || t.includes('non-aew')) return 'non_aew';
  return 'mid'; // default title matches to midcard tier if unclear
}

/** Parse one line:
 *  "A, B def. C, D | multi | fall:A | title:TBS | tournament:additional"
 */
function parseResultLine(line, order) {
  line = (line || '').trim();
  if (!line || line.startsWith('#')) return null;
  const parts = line.split('|').map(p => p.trim());
  const main = parts[0];
  const m = main.match(/^(.+?)\s+def\.?\s+(.+)$/i);
  if (!m) return null;
  const winners = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const losers = m[2].split(',').map(s => s.trim()).filter(Boolean);
  let isMulti = winners.length + losers.length >= 3;
  let fallWinner = winners[0];
  let titleName = '';
  let titleTier = 'none';
  let titleOutcome = 'none';
  let tournamentRound = 'none';
  let isTitle = false;

  parts.slice(1).forEach(p => {
    const low = p.toLowerCase();
    if (low === 'multi' || low.startsWith('multi')) isMulti = true;
    if (low.startsWith('fall:')) fallWinner = p.slice(5).trim();
    if (low.startsWith('title:')) {
      isTitle = true;
      titleName = p.slice(6).trim();
      titleTier = titleTierFromName(titleName);
      // default: first winner defended if (c) not specified — Devin can fix
      titleOutcome = 'defend';
      if (low.includes('new') || /and new/i.test(line)) titleOutcome = 'new';
    }
    if (low.startsWith('tournament:')) {
      const r = low.slice(11).trim();
      if (r.includes('final')) tournamentRound = 'finals';
      else if (r.includes('open')) tournamentRound = 'opening';
      else tournamentRound = 'additional';
    }
    if (low === 'newchamp' || low === 'titlechange') {
      isTitle = true;
      titleOutcome = 'new';
    }
  });

  const sides = [winners, losers];
  return {
    match_order: order,
    winners,
    losers,
    fall_winner: fallWinner,
    is_multi: isMulti,
    is_title_match: isTitle,
    title_name: titleName || null,
    title_tier: titleTier,
    title_outcome: titleOutcome,
    tournament_round: tournamentRound,
    sides
  };
}

function scoreMatchParticipants(match, isPpv) {
  const points = {}; // name -> { total, breakdown[] }
  const add = (name, result, extra) => {
    if (!name) return;
    const scored = scoreWrestlerInMatch({
      result,
      titleTier: match.is_title_match ? (match.title_tier || 'mid') : 'none',
      titleOutcome: match.is_title_match
        ? (result === 'win' ? (match.title_outcome || 'defend') : 'lose_title')
        : 'none',
      isPpv,
      isMultiPerson: !!match.is_multi,
      scoredTheFall: !!(match.fall_winner && name.toLowerCase() === match.fall_winner.toLowerCase()),
      tournamentRound: result === 'win' ? (match.tournament_round || 'none') : 'none'
    });
    if (!points[name]) points[name] = { total: 0, breakdown: [] };
    points[name].total += scored.total;
    points[name].breakdown.push(...scored.breakdown);
  };

  (match.winners || []).forEach(w => add(w, 'win'));
  (match.losers || []).forEach(w => add(w, 'lose'));
  return points;
}

function buildImportDraft(matches, meta) {
  const isPpv = !!meta.isPpv;
  const pointsMap = {};
  matches.forEach(match => {
    const scored = scoreMatchParticipants(match, isPpv);
    Object.entries(scored).forEach(([name, v]) => {
      if (!pointsMap[name]) pointsMap[name] = { total: 0, breakdown: [] };
      pointsMap[name].total += v.total;
      pointsMap[name].breakdown.push(...v.breakdown);
    });
  });

  // Player tag/rivalry bonuses across all matches
  const playerBonuses = {}; // pin -> { points, breakdown }
  Object.entries(data.users || {}).forEach(([pin, u]) => {
    if (!u.division) return;
    const roster = u.roster || [];
    let total = 0;
    const breakdown = [];
    matches.forEach((match, i) => {
      const b = computePlayerMatchBonuses(roster, match.sides || [match.winners, match.losers]);
      if (b.points > 0) {
        total += b.points;
        breakdown.push(`Match ${i + 1}: ` + b.breakdown.join('; '));
      }
    });
    if (total > 0) playerBonuses[pin] = { points: total, breakdown, name: u.name };
  });

  const rosterSet = new Set((data.masterRoster || []).map(n => n.toLowerCase()));
  Object.keys(pointsMap).forEach(name => {
    pointsMap[name].matched = !rosterSet.size || rosterSet.has(name.toLowerCase());
  });

  return { matches, pointsMap, playerBonuses, meta };
}

function openShowImportModal(draft) {
  currentShowImport = draft;
  const modal = document.getElementById('show-import-modal');
  if (!modal) return;
  document.getElementById('sim-title').textContent = 'SHOW RESULTS DRAFT — ' + (draft.meta.showLabel || 'Show');
  document.getElementById('sim-sub').textContent =
    (draft.meta.isPpv ? 'PPV' : 'TV') + ' · ' + (draft.meta.showDate || '') + ' · Source: ' + (draft.meta.source || 'paste');

  const mEl = document.getElementById('sim-matches');
  mEl.innerHTML = draft.matches.map((m, i) => {
    const title = m.is_title_match ? ` <span class="text-aew-gold">[${m.title_name || 'Title'}]</span>` : '';
    const fall = m.fall_winner ? ` · fall: <strong>${m.fall_winner}</strong>` : '';
    return `<div class="border border-gray-800 rounded-lg p-2">
      <div class="text-gray-400 text-xs">${i + 1}.${title}</div>
      <div>${(m.winners || []).join(', ')} <span class="text-gray-500">def.</span> ${(m.losers || []).join(', ')}</div>
      <div class="text-xs text-gray-500 mt-0.5">${m.is_multi ? 'multi' : 'singles'}${fall}${m.tournament_round && m.tournament_round !== 'none' ? ' · tournament:' + m.tournament_round : ''}</div>
    </div>`;
  }).join('') || '<p class="text-gray-500">No matches parsed</p>';

  const pEl = document.getElementById('sim-points');
  const names = Object.keys(draft.pointsMap).sort((a, b) => draft.pointsMap[b].total - draft.pointsMap[a].total);
  pEl.innerHTML = names.map(name => {
    const p = draft.pointsMap[name];
    const warn = p.matched === false ? 'text-amber-400' : '';
    return `<div class="flex items-center gap-2 ${warn}">
      <span class="flex-1 truncate">${name}</span>
      <input type="number" class="sim-pts w-16 bg-black border border-gray-700 rounded px-2 py-1 text-sm" data-name="${name.replace(/"/g, '&quot;')}" value="${p.total}" />
      <span class="text-xs text-gray-500 w-40 truncate" title="${p.breakdown.join(', ')}">${p.breakdown.join(', ')}</span>
    </div>`;
  }).join('');

  const unmatched = names.filter(n => draft.pointsMap[n].matched === false);
  document.getElementById('sim-unmatched').textContent = unmatched.length
    ? 'Unmatched to master roster: ' + unmatched.join(', ')
    : '';

  const bEl = document.getElementById('sim-player-bonuses');
  const pins = Object.keys(draft.playerBonuses);
  bEl.innerHTML = pins.length
    ? pins.map(pin => {
        const b = draft.playerBonuses[pin];
        return `<div><strong>${b.name || pin}</strong> +${b.points} <span class="text-xs text-gray-500">${b.breakdown.join(' | ')}</span></div>`;
      }).join('')
    : '<p class="text-gray-500 text-xs">None (no tag/rivalry bonuses detected)</p>';

  document.getElementById('sim-msg').textContent = '';
  modal.classList.remove('hidden');
}

function closeShowImportModal() {
  document.getElementById('show-import-modal')?.classList.add('hidden');
}

function readModalPointOverrides() {
  if (!currentShowImport) return;
  document.querySelectorAll('.sim-pts').forEach(inp => {
    const name = inp.dataset.name;
    const v = parseInt(inp.value, 10);
    if (name && currentShowImport.pointsMap[name] && !isNaN(v)) {
      currentShowImport.pointsMap[name].total = v;
      currentShowImport.pointsMap[name].override = true;
    }
  });
}

async function approveShowImport() {
  if (!isCommissioner()) return alert('Commissioner only');
  if (!currentShowImport) return;
  readModalPointOverrides();
  const msg = document.getElementById('sim-msg');
  try {
    if (msg) msg.textContent = 'Applying scores…';
    const sb = window.supabaseClient;

    // 1) wrestler_points upsert add
    for (const [name, p] of Object.entries(currentShowImport.pointsMap)) {
      if (!p.total) continue;
      const { data: existing } = await sb.from('wrestler_points').select('name, points').ilike('name', name).maybeSingle();
      const prev = existing?.points || 0;
      const next = prev + p.total;
      if (existing) {
        await sb.from('wrestler_points').update({ points: next }).eq('name', existing.name);
      } else {
        await sb.from('wrestler_points').insert({ name, points: next });
      }
    }

    // 2) team totals: sum points for wrestlers on each roster + player bonuses
    const scored = [];
    for (const [pin, u] of Object.entries(data.users || {})) {
      if (!u.division || u.purged) continue;
      let delta = 0;
      (u.roster || []).forEach(w => {
        const key = Object.keys(currentShowImport.pointsMap).find(n => n.toLowerCase() === String(w).toLowerCase());
        if (key) delta += currentShowImport.pointsMap[key].total || 0;
      });
      if (currentShowImport.playerBonuses[pin]) delta += currentShowImport.playerBonuses[pin].points;
      if (delta !== 0) {
        const newTotal = (data.points[pin] || 0) + delta;
        scored.push({ pin, newTotal, delta });
      }
    }

    for (const s of scored) {
      await sb.from('teams').update({ points: s.newTotal, last_delta: s.delta }).eq('pin', s.pin);
      data.points[s.pin] = s.newTotal;
      if (data.users[s.pin]) data.users[s.pin].lastDelta = s.delta;
    }

    // 3) optional log
    try {
      await sb.from('show_imports').insert({
        show_label: currentShowImport.meta.showLabel,
        show_date: currentShowImport.meta.showDate || null,
        source: currentShowImport.meta.source || 'paste',
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: currentUser,
        raw_json: { matches: currentShowImport.matches, points: currentShowImport.pointsMap, playerBonuses: currentShowImport.playerBonuses }
      });
    } catch (e) {
      console.warn('show_imports log skipped', e);
    }

    await clearPendingShowDraft();
    if (msg) msg.textContent = 'Approved. Standings updated.';
    closeShowImportModal();
    currentShowImport = null;
    await loadAllData();
    renderStandings();
    alert('Show scores approved and applied.');
  } catch (e) {
    console.error(e);
    if (msg) msg.textContent = 'Error: ' + (e.message || e);
    alert('Approve failed: ' + (e.message || e));
  }
}

function parsePasteToDraft() {
  const label = (document.getElementById('import-show-label')?.value || '').trim() || 'AEW Show';
  const date = document.getElementById('import-show-date')?.value || '';
  const isPpv = document.getElementById('import-is-ppv')?.value === 'ppv';
  const text = document.getElementById('import-paste')?.value || '';
  const lines = text.split(/\n+/);
  const matches = [];
  lines.forEach(line => {
    const m = parseResultLine(line, matches.length + 1);
    if (m) matches.push(m);
  });
  const msg = document.getElementById('import-msg');
  if (!matches.length) {
    if (msg) { msg.textContent = 'No matches parsed. Check format: Winner def. Loser | fall:Name'; msg.className = 'text-sm text-red-400'; }
    return;
  }
  const draft = buildImportDraft(matches, { showLabel: label, showDate: date, isPpv, source: 'paste' });
  draft.playerBonuses = recomputePlayerBonuses(matches);
  savePendingShowDraft(draft).catch(() => {});
  if (msg) { msg.textContent = `Parsed ${matches.length} matches. Rosters used for tag/rivalry bonuses. Review the draft.`; msg.className = 'text-sm text-emerald-400'; }
  openShowImportModal(draft);
}

function fillImportFromCalendar() {
  const sel = document.getElementById('import-from-cal');
  if (!sel) return;
  const id = sel.value;
  const ev = (data.calendarEvents || []).find(e => String(e.id) === String(id));
  if (!ev) return;
  const labelEl = document.getElementById('import-show-label');
  const dateEl = document.getElementById('import-show-date');
  const ppvEl = document.getElementById('import-is-ppv');
  if (labelEl) labelEl.value = ev.name || '';
  if (dateEl && ev.event_date) dateEl.value = String(ev.event_date).slice(0, 10);
  if (ppvEl) ppvEl.value = normalizeEventType(ev.event_type) === 'ppv' ? 'ppv' : 'tv';
}

function populateImportCalendarSelect() {
  const sel = document.getElementById('import-from-cal');
  if (!sel) return;
  const events = (data.calendarEvents || [])
    .filter(e => ['weekly_tv', 'special_tv', 'ppv'].includes(normalizeEventType(e.event_type)))
    .slice()
    .sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
  sel.innerHTML = '<option value="">— select event —</option>' +
    events.map(e => `<option value="${e.id}">${e.name} (${e.event_date || 'no date'})</option>`).join('');
}

function wireShowImportUI() {
  document.getElementById('import-parse-btn')?.addEventListener('click', parsePasteToDraft);
  document.getElementById('import-from-cal')?.addEventListener('change', fillImportFromCalendar);
  document.getElementById('import-open-pending-btn')?.addEventListener('click', () => {
    if (currentShowImport) openShowImportModal(currentShowImport);
    else alert('No draft in memory. Paste results and click Parse & Score Draft.');
  });
  document.getElementById('sim-reject')?.addEventListener('click', () => {
    clearPendingShowDraft().catch(() => {});
    currentShowImport = null;
    closeShowImportModal();
  });
  document.getElementById('sim-save-edits')?.addEventListener('click', () => {
    readModalPointOverrides();
    document.getElementById('sim-msg').textContent = 'Edits kept in this session. Click APPROVE to apply.';
  });
  document.getElementById('sim-approve')?.addEventListener('click', approveShowImport);
}

// Hook into commissioner render
const _renderCommissionerOrig = typeof renderCommissioner === 'function' ? renderCommissioner : null;
if (_renderCommissionerOrig) {
  renderCommissioner = function() {
    _renderCommissionerOrig();
    try { populateImportCalendarSelect(); } catch (e) {}
  };
}

document.addEventListener('DOMContentLoaded', () => {
  try { wireShowImportUI(); } catch (e) { console.warn(e); }
});
try { wireShowImportUI(); } catch (e) {}

// After data loads, commissioner gets pending draft popup automatically
const _loadAllDataOrig = loadAllData;
loadAllData = async function() {
  await _loadAllDataOrig.apply(this, arguments);
  try {
    setTimeout(() => { tryAutoLockDraftOrders().catch(() => {}); }, 600);
    if (typeof isCommissioner === 'function' && isCommissioner()) {
      setTimeout(() => { tryAutoBuildDraftForDueShows().catch(() => {}); }, 800);
      setTimeout(() => { tryAutoProcessWaivers().catch(() => {}); }, 1200);
    }
  } catch (e) {}
};




// ===== Emergency login (works even if DOMContentLoaded bootstrap glitches) =====
window.tryLogin = async function() {
  const err = document.getElementById('login-error');
  const input = document.getElementById('pin-input');
  const pin = (input && input.value || '').trim().toLowerCase();
  const showErr = (m) => {
    if (err) { err.textContent = m; err.classList.remove('hidden'); }
    else alert(m);
  };
  try {
    if (!pin || pin.length > 10 || !/^[a-z0-9]+$/i.test(pin)) {
      showErr('PIN must be 1-10 letters or numbers only');
      return;
    }
    if (!window.supabaseClient) {
      showErr('Database client not ready. Hard refresh and try again.');
      return;
    }
    if (!data.users || !Object.keys(data.users).length) {
      await loadAllData();
    }
    if (!data.users['doublej']) {
      data.users['doublej'] = { name: 'Double J', division: null, isCommissioner: false, readOnly: true, maxRoster: 0, roster: [], lastDelta: null };
    }
    const res = login(pin);
    if (!res.ok) {
      showErr(res.error || 'PIN not found');
      return;
    }
    await loadAllData();
    enterApp();
  } catch (e) {
    console.error('tryLogin', e);
    showErr('Login failed: ' + (e.message || e));
  }
};

document.getElementById('login-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  window.tryLogin();
});
document.getElementById('pin-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    window.tryLogin();
  }
});
