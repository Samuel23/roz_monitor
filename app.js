/**
 * ROZ Live Monitor - Client Application Logic
 * Version: 1.3.1
 */

const $ = id => document.getElementById(id);
let activeTab = 'overview';
let currentInv = [];
let lastSnapshot = null;
let activeStreamUrl = '';
let isResolvingStream = false;
// Set when the PC answers 401. Polling stops until the PIN is entered
// again: the overlay throttles an address that keeps failing, so a
// dashboard that retries twice a second with a stale PIN locks itself
// out and then cannot get back in even once the PIN is right.
let authBlocked = false;
// One same-origin probe at a time: tick() and the background resolver both
// call resolveAndConnect, and Tier 0 runs ahead of the isResolvingStream gate.
let selfProbing = false;
let failedPolls = 0;
let prevHp = null;
let prevBaseLv = null;
let mapCache = {};
// Maps whose image is being fetched right now - see drawMap.
let mapPending = {};

const n = v => v == null ? '-' : Math.abs(v) >= 1e9 ? (v/1e9).toFixed(2)+'B' : Math.abs(v) >= 1e6 ? (v/1e6).toFixed(2)+'M' : Math.abs(v) >= 1e4 ? (v/1e3).toFixed(1)+'k' : Math.round(v).toLocaleString();
const dur = s => {
  if (s == null) return '-'; s = Math.max(0, s|0);
  const d = s/86400|0, h = s%86400/3600|0, m = s%3600/60|0;
  return d ? d+'d '+h+'h' : h ? h+'h '+String(m).padStart(2,'0')+'m' : m ? m+'m '+String(s%60).padStart(2,'0')+'s' : s+'s';
};

// --- Pairing Management ---
function getRoom() {
  const urlParams = new URLSearchParams(window.location.search);
  const r = urlParams.get('room') || urlParams.get('r');
  if (r) {
    localStorage.setItem('roz_room', r.toUpperCase());
    return r.toUpperCase();
  }
  return (localStorage.getItem('roz_room') || '').toUpperCase();
}

// The PIN travels in the URL *fragment* (#pin=...), which browsers never put
// on the wire: it stays out of the tunnel provider's access logs and out of
// the Referer header of every request this page makes afterwards. A `?pin=`
// query is still read so links made by an older overlay keep working, and
// either way it is moved into localStorage and scrubbed from the address bar
// so it does not sit in the phone's history or get shared with a screenshot.
function getPin() {
  const fromUrl = () => {
    const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const q = new URLSearchParams(window.location.search);
    return hash.get('pin') || hash.get('p') || q.get('pin') || q.get('p');
  };
  const p = fromUrl();
  if (p) {
    localStorage.setItem('roz_pin', p.toUpperCase());
    try {
      const q = new URLSearchParams(window.location.search);
      q.delete('pin'); q.delete('p');
      const qs = q.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    } catch (e) { /* older browser: the value is stored either way */ }
    return p.toUpperCase();
  }
  return (localStorage.getItem('roz_pin') || '').toUpperCase();
}

// Every call to the overlay goes through here. The PIN is sent as a bearer
// token and never as a query parameter - see getPin above for why.
function apiFetch(url, opts) {
  const pin = getPin();
  const o = Object.assign({}, opts || {});
  o.headers = Object.assign({}, o.headers || {});
  if (pin) o.headers['Authorization'] = 'Bearer ' + pin;
  return fetch(url, o);
}

function getStreamParam() {
  const urlParams = new URLSearchParams(window.location.search);
  const s = urlParams.get('stream') || urlParams.get('s') || urlParams.get('url');
  if (s) {
    localStorage.setItem('roz_stream_url', s);
    return s;
  }
  return localStorage.getItem('roz_stream_url') || '';
}

function submitPairing() {
  const room = $('pairRoomInput').value.trim().toUpperCase();
  const pin = $('pairPinInput').value.trim().toUpperCase();
  // A room code is how a phone finds a PC across the internet. When this page
  // was served by the overlay itself there is no PC to find - it is the origin
  // this file came from - and the PIN alone is the whole of what is missing.
  // Requiring a room here made Connect a silent no-op on the overlay's own
  // address: the dialog stayed up with the correct PIN typed into it and no
  // way to get past it, which reads as "the PIN does not work".
  if (!room && !(pin && selfHosted())) return;
  if (room) localStorage.setItem('roz_room', room);
  if (pin) localStorage.setItem('roz_pin', pin);
  $('pairModal').classList.remove('show');
  authBlocked = false;
  lastInventory = null;
  lastInventoryKey = null;
  lastMap = null;
  lastMapKey = null;
  resolveAndConnect();
}

function rePair() {
  $('pairRoomInput').value = getRoom();
  $('pairPinInput').value = getPin();
  $('pairModal').classList.add('show');
}

function unpair() {
  localStorage.removeItem('roz_room');
  localStorage.removeItem('roz_pin');
  localStorage.removeItem('roz_stream_url');
  activeStreamUrl = '';
  window.location.href = window.location.pathname;
}

// Is this page being served by the overlay itself? If it is, the PC is not
// something to go looking for - it is the origin this file came from.
function selfHosted() {
  return /^https?:$/.test(window.location.protocol) &&
         !/github\.io$|\.pages\.dev$/.test(window.location.hostname);
}

// --- Cloud Stream Discovery ---
async function resolveAndConnect() {
  const room = getRoom();

  // Tier 0: same origin. A dashboard opened at the overlay's own address
  // already knows where the PC is, and asking it for a room code is asking a
  // question it is standing on the answer to. Pairing exists for a phone
  // loading this page from GitHub Pages, not for localhost:8777 - which, in a
  // browser with no saved room, sat behind the pairing dialog forever with
  // live telemetry one request away on the very same origin.
  if (selfHosted() && !selfProbing) {
    selfProbing = true;
    try {
      const res = await apiFetch(`/status.json?t=${Date.now()}&lean=1`,
                                { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        activeStreamUrl = window.location.origin;
        authBlocked = false;
        $('pairModal').classList.remove('show');
        $('cfgStreamUrl').textContent = activeStreamUrl;
        $('charLoc').textContent = 'connected (this PC)';
        $('liveDot').classList.remove('off');
        tick();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        // The overlay is right here; only the PIN is missing. Ask for that
        // and nothing else.
        activeStreamUrl = window.location.origin;
        $('cfgStreamUrl').textContent = activeStreamUrl;
        authBlocked = true;
        rePair();
        return;
      }
    } catch (e) {
      /* not an overlay origin after all - fall through to pairing */
    } finally {
      selfProbing = false;
    }
  }

  if (!room) {
    $('pairModal').classList.add('show');
    return;
  }
  $('hdrRoom').textContent = `ROOM: ${room}`;
  $('cfgRoomDisplay').textContent = room;
  $('cfgPinDisplay').textContent = getPin() ? '••••' : 'None';

  if (isResolvingStream) return;
  isResolvingStream = true;
  $('charLoc').textContent = 'finding PC…';

  try {
    // Tier 1: Direct stream parameter if provided
    const directStream = getStreamParam();
    if (directStream) {
      try {
        const candidate = directStream.replace(/[/]+$/, '');
        const testRes = await apiFetch(`${candidate}/status.json?t=${Date.now()}`, { signal: AbortSignal.timeout(3000) });
        if (testRes.ok || testRes.status === 401 || testRes.status === 403) {
          activeStreamUrl = candidate;
          $('cfgStreamUrl').textContent = activeStreamUrl;
          $('charLoc').textContent = 'connected!';
          $('liveDot').classList.remove('off');
          tick();
          return;
        }
      } catch (e) {}
    }

    // Tier 2: Local loopback (instant on PC desktop browser)
    try {
      const localRes = await apiFetch(`http://127.0.0.1:8777/status.json?t=${Date.now()}`, { signal: AbortSignal.timeout(1200) });
      if (localRes.ok || localRes.status === 401 || localRes.status === 403) {
        activeStreamUrl = 'http://127.0.0.1:8777';
        $('cfgStreamUrl').textContent = activeStreamUrl;
        $('charLoc').textContent = 'connected (local)';
        $('liveDot').classList.remove('off');
        tick();
        return;
      }
    } catch (e) {}

    // Tier 3: Multi-relay cloud discovery
    const servers = ['https://ntfy.envs.net', 'https://ntfy.sh'];
    const topic = `roz_${room.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    for (const srv of servers) {
      try {
        const res = await fetch(`${srv}/${encodeURIComponent(topic)}/json?poll=1&since=all`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const text = await res.text();
          const lines = text.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const item = JSON.parse(lines[i]);
              if (item.message) {
                const data = JSON.parse(item.message);
                if (data.url) {
                  const candidateUrl = data.url.replace(/[/]+$/, '');
                  try {
                    // The relay answers with a location and nothing else. It
                    // used to carry the PIN as well, which meant anyone who
                    // could read the topic got the address and the credential
                    // together - so the PIN guarded nothing. The one the user
                    // typed is the only one we will ever send.
                    const testRes = await apiFetch(`${candidateUrl}/status.json?t=${Date.now()}`, { signal: AbortSignal.timeout(3500) });
                    if (testRes.ok || testRes.status === 401 || testRes.status === 403) {
                      activeStreamUrl = candidateUrl;
                      localStorage.setItem('roz_stream_url', candidateUrl);
                      $('cfgStreamUrl').textContent = activeStreamUrl;
                      $('charLoc').textContent = 'connected!';
                      $('liveDot').classList.remove('off');
                      tick();
                      return;
                    }
                  } catch (connErr) {}
                }
              }
            } catch(e){}
          }
        }
      } catch (srvErr) {}
    }

    $('charLoc').innerHTML = '<span style="color:var(--bad);cursor:pointer;" onclick="resolveAndConnect()">🔴 PC Offline (retrying…)</span>';
    $('liveDot').classList.add('off');
    activeStreamUrl = '';
  } catch(err) {
    $('charLoc').innerHTML = '<span style="color:var(--bad);cursor:pointer;" onclick="resolveAndConnect()">🔴 PC Offline (retrying…)</span>';
    $('liveDot').classList.add('off');
    activeStreamUrl = '';
  } finally {
    isResolvingStream = false;
  }
}

// Background auto-resolver every 4s when offline
setInterval(() => {
  if (!authBlocked && !activeStreamUrl && getRoom()) {
    resolveAndConnect();
  }
}, 4000);

// --- Navigation ---
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const targetTab = $('tab-' + name);
  if (targetTab) targetTab.classList.add('active');
  const btns = document.querySelectorAll('.nav-item');
  const tabs = ['overview', 'combat', 'map', 'loot', 'chat', 'history', 'settings'];
  const idx = tabs.indexOf(name);
  if (idx !== -1 && btns[idx]) btns[idx].classList.add('active');
  if (name === 'map' && lastSnapshot) {
    refreshMap();
    drawMap(lastSnapshot.location || {}, lastSnapshot.actors || lastSnapshot.monsters || []);
  } else if (name === 'loot') {
    updateSubPills();
    updateInvSource();
    refreshInventory(true);
  } else if (name === 'history') {
    loadHistory();
  }
}

// --- History Management ---
let selectedHistoryDate = 'today';
let selectedHistoryChar = 'all';
let historyIndexData = { dates: [] };
let currentHistoryData = null;

async function loadHistory() {
  const url = activeStreamUrl || window.location.origin;
  try {
    const res = await apiFetch(`${url}/api/history`);
    if (res.ok) {
      historyIndexData = await res.json();
      renderHistoryDatePills();
      selectHistoryDate(selectedHistoryDate || 'today');
    }
  } catch(e) {}
}

function renderHistoryDatePills() {
  const container = $('historyDatePills');
  if (!container) return;
  const dates = historyIndexData.dates || [];
  let html = `<button class="client-pill ${selectedHistoryDate === 'today' ? 'active' : ''}" onclick="selectHistoryDate('today')">Today</button>`;
  dates.forEach(d => {
    const isSel = selectedHistoryDate === d.date;
    html += `<button class="client-pill ${isSel ? 'active' : ''}" onclick="selectHistoryDate('${d.date}')">${d.date}</button>`;
  });
  container.innerHTML = html;
}

function renderHistoryCharPills(charNames) {
  const container = $('historyCharPills');
  if (!container) return;
  if (!charNames || charNames.length <= 1) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  let html = `<button class="client-pill ${selectedHistoryChar === 'all' ? 'active' : ''}" onclick="selectHistoryChar('all')">All Characters</button>`;
  charNames.forEach(c => {
    const isSel = selectedHistoryChar === c;
    html += `<button class="client-pill ${isSel ? 'active' : ''}" onclick="selectHistoryChar('${escapeHtml(c)}')">${escapeHtml(c)}</button>`;
  });
  container.innerHTML = html;
}

function selectHistoryChar(charName) {
  selectedHistoryChar = charName;
  selectHistoryDate(selectedHistoryDate);
}

async function selectHistoryDate(dateStr) {
  selectedHistoryDate = dateStr;
  renderHistoryDatePills();
  const pin = getPin();
  const url = activeStreamUrl || window.location.origin;
  
  if (dateStr === 'today' && lastSnapshot) {
    const clients = lastSnapshot.clients || [];
    const charNames = clients.map(c => c.name).filter(Boolean);
    renderHistoryCharPills(charNames);

    let targetClient = lastSnapshot;
    if (selectedHistoryChar !== 'all' && clients.length > 0) {
      const match = clients.find(c => c.name === selectedHistoryChar);
      if (match) targetClient = match;
    }

    const s = targetClient;
    const c = s.character || s;
    const e = s.exp || {};
    const z = s.zeny || {};
    const k = s.combat || {};
    const sess = s.session || {};
    
    $('histBaseExp').textContent = n(e.gained_base ?? s.gained_base);
    $('histJobExp').textContent = n(e.gained_job ?? s.gained_job);
    $('histZeny').textContent = n((z.gained || 0) - (z.spent || 0));
    $('histKills').textContent = (k.kills ?? s.kills ?? 0).toLocaleString();
    $('histActiveTime').textContent = dur(sess.active_sec ?? s.active_sec);
    $('histBestHit').textContent = n(k.best_hit ?? s.best_hit);

    const mobBreakdown = (s.combat && s.combat.kills_breakdown) || s.kills_breakdown || {};
    const mobEntries = Object.entries(mobBreakdown);
    $('histMobTotal').textContent = `${(k.kills ?? s.kills ?? 0).toLocaleString()} Kills`;
    if (mobEntries.length) {
      $('histMobTable').innerHTML = mobEntries.sort((a, b) => b[1] - a[1]).map(([name, count]) => `
        <tr><td><b>${escapeHtml(name)}</b></td><td style="text-align:right;font-weight:700;">${count.toLocaleString()}</td></tr>
      `).join('');
    } else {
      $('histMobTable').innerHTML = '<tr><td style="color:var(--dim)">No kills recorded yet</td><td></td></tr>';
    }

    const lootList = (s.loot && s.loot.items) || s.loot || [];
    const lootArr = Array.isArray(lootList) ? lootList : Object.entries(lootList || {}).map(([itid, count]) => ({itid, count}));
    $('histLootTotal').textContent = `${(s.loot?.total || lootArr.length).toLocaleString()} Items`;
    if (lootArr.length) {
      $('histLootTable').innerHTML = lootArr.map(item => `
        <tr>
          <td>-</td>
          <td>
            <div class="item-row">
              <img src="https://midgardhub.com/images/items/${item.itid}.gif" onerror="this.src='https://midgardhub.com/images/items/${item.itid}.png';this.onerror=null;" class="item-icon" alt="">
              <a href="https://midgardhub.com/database/items/${item.itid}" target="_blank" class="item-link">${item.name || ('Item #' + item.itid)}</a>
            </div>
          </td>
          <td style="text-align:right;font-weight:700;">${(item.count || 0).toLocaleString()}</td>
        </tr>
      `).join('');
    } else {
      $('histLootTable').innerHTML = '<tr><td colspan="3" style="color:var(--dim)">No loot drops recorded</td></tr>';
    }
    return;
  }

  try {
    const charParam = selectedHistoryChar !== 'all' ? `&char=${encodeURIComponent(selectedHistoryChar)}` : '';
    const res = await apiFetch(`${url}/api/history?date=${encodeURIComponent(dateStr)}${charParam}`);
    if (res.ok) {
      const data = await res.json();
      currentHistoryData = data;
      
      const charNames = data.character_names || (data.characters ? Object.keys(data.characters) : []);
      renderHistoryCharPills(charNames);

      let targetData = data;
      if (selectedHistoryChar !== 'all' && data.characters && data.characters[selectedHistoryChar]) {
        targetData = data.characters[selectedHistoryChar];
      }
      
      $('histBaseExp').textContent = n(targetData.total_base_exp ?? targetData.gained_base);
      $('histJobExp').textContent = n(targetData.total_job_exp ?? targetData.gained_job);
      $('histZeny').textContent = n(targetData.total_zeny_net ?? targetData.zeny_net);
      $('histKills').textContent = (targetData.total_kills ?? targetData.kills_total ?? 0).toLocaleString();
      $('histActiveTime').textContent = dur(targetData.total_active_sec ?? targetData.active_sec);
      $('histBestHit').textContent = n(targetData.best_hit);

      // Kills table
      let allKills = {};
      if (targetData.kills_breakdown) {
        allKills = targetData.kills_breakdown;
      } else if (data.characters && typeof data.characters === 'object') {
        Object.values(data.characters).forEach(c => {
          Object.entries(c.kills_breakdown || {}).forEach(([m, count]) => {
            allKills[m] = (allKills[m] || 0) + count;
          });
        });
      }
      const mobEntries = Object.entries(allKills);
      $('histMobTotal').textContent = `${(targetData.total_kills ?? targetData.kills_total ?? 0).toLocaleString()} Kills`;
      if (mobEntries.length) {
        $('histMobTable').innerHTML = mobEntries.sort((a, b) => b[1] - a[1]).map(([name, count]) => `
          <tr><td><b>${escapeHtml(name)}</b></td><td style="text-align:right;font-weight:700;">${count.toLocaleString()}</td></tr>
        `).join('');
      } else {
        $('histMobTable').innerHTML = '<tr><td style="color:var(--dim)">No kills recorded</td><td></td></tr>';
      }

      // Loot ledger table
      let ledger = targetData.loot_ledger || [];
      if (!ledger.length && data.characters && typeof data.characters === 'object') {
        Object.values(data.characters).forEach(c => {
          if (c.loot_ledger) ledger = ledger.concat(c.loot_ledger);
        });
      }
      $('histLootTotal').textContent = `${ledger.length} Drops`;
      if (ledger.length) {
        $('histLootTable').innerHTML = ledger.slice(-50).reverse().map(item => `
          <tr>
            <td style="color:var(--dim);font-size:11px;">${item.time || '-'}</td>
            <td>
              <div class="item-row">
                <img src="https://midgardhub.com/images/items/${item.itid}.gif" onerror="this.src='https://midgardhub.com/images/items/${item.itid}.png';this.onerror=null;" class="item-icon" alt="">
                <a href="https://midgardhub.com/database/items/${item.itid}" target="_blank" class="item-link">${item.name || ('Item #' + item.itid)}</a>
              </div>
            </td>
            <td style="text-align:right;font-weight:700;">${(item.count || 1).toLocaleString()}</td>
          </tr>
        `).join('');
      } else {
        $('histLootTable').innerHTML = '<tr><td colspan="3" style="color:var(--dim)">No loot drops recorded</td></tr>';
      }
    }
  } catch(e) {}
}

// --- Synthesized Audio Alarms ---
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function alarmLowHp() {
  try {
    const ctx = getAudioContext();
    let t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.linearRampToValueAtTime(440, t + 0.15);
      g.gain.setValueAtTime(0.3, t);
      g.gain.linearRampToValueAtTime(0.01, t + 0.15);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.15);
      t += 0.2;
    }
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch(e){}
}

function alarmLevelUp() {
  try {
    const ctx = getAudioContext();
    let t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + i * 0.1);
      g.gain.setValueAtTime(0.25, t + i * 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.25);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t + i * 0.1); osc.stop(t + i * 0.1 + 0.25);
    });
  } catch(e){}
}

// --- Actor Filter & Render ---
let currentActors = [];
let actorFilter = 'all';

function setActorFilter(f) {
  actorFilter = f;
  ['pillAll', 'pillMobs', 'pillPlayers', 'pillNpcs'].forEach(id => {
    const el = $(id);
    if (el) el.classList.remove('active');
  });
  if (f === 'all' && $('pillAll')) $('pillAll').classList.add('active');
  if (f === 'mob' && $('pillMobs')) $('pillMobs').classList.add('active');
  if (f === 'player' && $('pillPlayers')) $('pillPlayers').classList.add('active');
  if (f === 'npc' && $('pillNpcs')) $('pillNpcs').classList.add('active');
  renderActorList();
}

function renderActorList() {
  const container = $('mobListContainer');
  if (!container) return;

  let list = currentActors || [];
  if (actorFilter === 'mob') list = list.filter(a => !a.kind || a.kind === 'mob');
  else if (actorFilter === 'player') list = list.filter(a => a.kind === 'player');
  else if (actorFilter === 'npc') list = list.filter(a => a.kind === 'npc' || a.kind === 'portal');

  $('mobCount').textContent = currentActors ? currentActors.length : 0;

  if (list && list.length > 0) {
    container.innerHTML = list.map(a => {
      const isMob = !a.kind || a.kind === 'mob';
      const isPlayer = a.kind === 'player';
      const isPortal = a.kind === 'portal';
      const isNpc = a.kind === 'npc';

      if (isMob) {
        return `
          <div class="mob-card">
            <div class="mob-left">
              <img src="https://midgardhub.com/images/monsters/${a.id}.gif" onerror="this.onerror=null;this.src='https://midgardhub.com/images/monsters/${a.id}.png';" class="mob-icon" alt="">
              <div>
                <div>
                  <a href="https://midgardhub.com/database/monsters/${a.id}" target="_blank" class="mob-name">${a.name || ('Mob #' + a.id)}</a>
                  ${a.boss ? '<span class="boss-tag">BOSS</span>' : ''}
                </div>
                <div class="mob-hp">Pos: (${a.x}, ${a.y})${a.hp && a.hp > 0 ? ` · HP: ${a.hp.toLocaleString()}` : ''}</div>
              </div>
            </div>
            <a href="https://midgardhub.com/database/monsters/${a.id}" target="_blank" style="color:var(--dim);font-size:11px;text-decoration:none;padding:4px 6px;border:1px solid #2a3142;border-radius:4px;">↗ DB</a>
          </div>
        `;
      } else if (isPlayer) {
        return `
          <div class="mob-card" style="border-left: 3px solid var(--acc);">
            <div class="mob-left">
              <img src="jobicons/icon_job_${a.id}.png" onerror="this.onerror=null;this.src='jobicons/icon_job_0.png';" class="mob-icon" alt="">
              <div>
                <div>
                  <span class="mob-name" style="color:var(--acc);">${a.name}</span>
                  <span class="player-tag">${a.job || 'Player'}</span>
                </div>
                <div class="mob-hp">Pos: (${a.x}, ${a.y})${a.hp && a.hp > 0 ? ` · HP: ${a.hp.toLocaleString()}` : ''}</div>
              </div>
            </div>
            <span style="color:var(--dim);font-size:11px;">Player</span>
          </div>
        `;
      } else {
        return `
          <div class="mob-card" style="border-left: 3px solid var(--good);">
            <div class="mob-left">
              <div style="font-size: 20px; width: 36px; text-align: center;">${isPortal ? '🌀' : '🏛️'}</div>
              <div>
                <div>
                  <span class="mob-name" style="color:var(--good);">${a.name}</span>
                  <span class="npc-tag">${isPortal ? 'WARP' : 'NPC'}</span>
                </div>
                <div class="mob-hp">Pos: (${a.x}, ${a.y})</div>
              </div>
            </div>
            <span style="color:var(--dim);font-size:11px;">${isPortal ? 'Portal' : 'NPC'}</span>
          </div>
        `;
      }
    }).join('');
  } else {
    container.innerHTML = `
      <div style="color:var(--dim);text-align:center;padding:24px 10px;font-size:12px;">
        No ${actorFilter === 'all' ? 'entities' : actorFilter + 's'} currently in sight<br>
        <span style="font-size:11px;color:#50576a;">Walk near entities to track on radar</span>
      </div>`;
  }
}

// --- Minimap Canvas ---
function drawMap(loc, actors = []) {
  const canvas = $('mapCanvas');
  if (!canvas) return;
  const g = canvas.getContext('2d');
  const S = canvas.width;
  g.clearRect(0, 0, S, S);

  currentActors = (actors && actors.length > 0) ? actors : (lastSnapshot && (lastSnapshot.actors || lastSnapshot.monsters)) || [];

  const mapName = loc.map || '';
  const x = loc.x || 0, y = loc.y || 0;
  $('mapCoords').textContent = mapName ? `${mapName} (${x}, ${y})` : 'No map';

  if (!mapName) {
    g.fillStyle = '#1b1f2b'; g.font = '12px Segoe UI'; g.textAlign = 'center';
    g.fillText('Waiting for map data…', S / 2, S / 2);
    renderActorList();
    return;
  }

  // Draw the cached PNG, or go and get it. An <img src> cannot carry an
  // Authorization header, so the image is fetched like every other endpoint
  // and handed to the Image as an object URL. `pending` keeps a slow fetch
  // from being started again on each of the frames drawn while it is in
  // flight.
  if (!mapCache[mapName]) {
    if (!mapPending[mapName]) {
      mapPending[mapName] = true;
      apiFetch((activeStreamUrl || '') + `/map.png?m=${encodeURIComponent(mapName)}`)
        .then(r => r.ok ? r.blob() : Promise.reject(r.status))
        .then(blob => new Promise((ok, no) => {
          const img = new Image();
          const href = URL.createObjectURL(blob);
          img.onload = () => { URL.revokeObjectURL(href); ok(img); };
          img.onerror = () => { URL.revokeObjectURL(href); no('decode'); };
          img.src = href;
        }))
        .then(img => { mapCache[mapName] = img; drawMap(loc, currentActors); })
        .catch(() => {})
        .finally(() => { delete mapPending[mapName]; });
    }
  } else {
    g.drawImage(mapCache[mapName], 0, 0, S, S);
  }

  // Project player coordinates
  const cells = loc.cells || [400, 400];
  const maxC = Math.max(cells[0], cells[1]) || 400;
  const offX = (maxC - cells[0]) / 2, offY = (maxC - cells[1]) / 2;

  // Draw walked trail. It comes from /map.json, not the telemetry snapshot;
  // loc.trail is the fallback for an older overlay that still inlines it.
  const mapPayload = (lastMapKey === (selectedClientKey || '') && lastMap) || {};
  const trail = (mapPayload.map === loc.map ? mapPayload.trail : null) || loc.trail || [];
  if (trail.length > 1) {
    g.strokeStyle = '#7fd1ff'; g.lineWidth = 1.5;
    g.beginPath();
    trail.forEach((p, idx) => {
      const tx = (p[0] + offX) / maxC * S;
      const ty = (maxC - (p[1] + offY)) / maxC * S;
      if (idx === 0) g.moveTo(tx, ty); else g.lineTo(tx, ty);
    });
    g.stroke();
  }

  // Draw Nearby Actors on Radar
  currentActors.forEach(a => {
    const ax = (a.x + offX) / maxC * S;
    const ay = (maxC - (a.y + offY)) / maxC * S;
    const kind = a.kind || 'mob';

    if (kind === 'player') {
      g.fillStyle = '#00d4ff'; g.strokeStyle = '#ffffff'; g.lineWidth = 1;
      g.beginPath(); g.arc(ax, ay, 4, 0, Math.PI * 2); g.fill(); g.stroke();
    } else if (kind === 'npc' || kind === 'portal') {
      g.fillStyle = '#2ecc71'; g.strokeStyle = '#10131a'; g.lineWidth = 1;
      g.beginPath(); g.arc(ax, ay, 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
    } else if (a.boss) {
      g.fillStyle = '#ffd479'; g.strokeStyle = '#ff4d4d'; g.lineWidth = 2;
      g.beginPath(); g.arc(ax, ay, 6, 0, Math.PI * 2); g.fill(); g.stroke();
    } else {
      // High-visibility crimson monster blip
      g.fillStyle = 'rgba(255, 77, 77, 0.4)';
      g.beginPath(); g.arc(ax, ay, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ff3333'; g.strokeStyle = '#ffffff'; g.lineWidth = 1;
      g.beginPath(); g.arc(ax, ay, 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  });

  // Draw Player Dot
  const px = (x + offX) / maxC * S;
  const py = (maxC - (y + offY)) / maxC * S;
  g.strokeStyle = '#ffd479'; g.fillStyle = '#ffd479';
  g.beginPath(); g.arc(px, py, 7, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();

  renderActorList();
}

let invCategory = 'inventory';
let invSubCategory = 'all';
// Bags, carts, storage and the drop tally are no longer part of the
// once-a-second telemetry: they are most of its weight and change a couple of
// times an hour. They are fetched from /inventory.json while the Loot tab is
// open, and cached here between refreshes.
let lastInventory = null;
let lastInventoryKey = null;
let inventoryFetching = false;
let invTicks = 0;
// The walked trail is the same kind of payload: up to 400 cells, drawn only by
// the map, and the largest single thing left in the telemetry snapshot.
let lastMap = null;
let lastMapKey = null;
let mapFetching = false;

async function refreshMap() {
  const key = selectedClientKey || '';
  if (mapFetching || !activeStreamUrl) return;
  mapFetching = true;
  try {
    const clientParam = selectedClientKey ? `&client=${encodeURIComponent(selectedClientKey)}` : '';
    const res = await apiFetch(`${activeStreamUrl}/map.json?t=${Date.now()}${clientParam}`);
    if (res.ok) {
      lastMap = await res.json();
      lastMapKey = key;
      if (activeTab === 'map' && lastSnapshot) {
        drawMap(lastSnapshot.location || {}, lastSnapshot.actors || lastSnapshot.monsters || []);
      }
    }
  } catch (e) {
    /* the next tick tries again */
  } finally {
    mapFetching = false;
  }
}

async function refreshInventory(force) {
  const key = selectedClientKey || '';
  if (inventoryFetching || (!force && lastInventoryKey === key && lastInventory)) return;
  if (!activeStreamUrl) return;
  inventoryFetching = true;
  try {
    const clientParam = selectedClientKey ? `&client=${encodeURIComponent(selectedClientKey)}` : '';
    const res = await apiFetch(`${activeStreamUrl}/inventory.json?t=${Date.now()}${clientParam}`);
    if (res.ok) {
      lastInventory = await res.json();
      lastInventoryKey = key;
      lastRenderedInvSig = '';
      if (activeTab === 'loot') updateInvSource();
    }
  } catch (e) {
    /* the next tick tries again */
  } finally {
    inventoryFetching = false;
  }
}
let invSortMode = 'slot'; // 'slot', 'qty', 'name'
let lastRenderedInvSig = '';

// Which equipment slots an item can occupy, as a bitmask. A costume hat and an
// ordinary one share the same item category, so the slot is what separates
// them; a two-handed weapon takes both hand slots and is still a weapon.
const LOC_COSTUME = 0x007C00;   // top, mid, low, garment, floor
const LOC_SHADOW  = 0x3F0000;   // shadow armor/weapon/shield/shoes/accessories
const LOC_R_HAND  = 0x000002;
const LOC_L_HAND  = 0x000020;
const LOC_AMMO    = 0x008000;

function classifyItem(itemType, itid, name, location) {
  const loc = Number(location) || 0;

  // Costume first, and from the equip location alone. Item ids are not handed
  // out in tidy blocks - 450347 and 460058 are plain armours sitting inside
  // the old "400000-499999 is a costume" range - and names are no better,
  // since plenty of costumes carry no "[Costume]" tag. The slot the client
  // says the item goes in is the only thing that actually decides it.
  if (loc & (LOC_COSTUME | LOC_SHADOW)) return 'costume';

  // Then by where it is worn, which beats the type byte because it is
  // unambiguous: a two-hander occupies both hands and is still a weapon.
  if (loc & (LOC_R_HAND | LOC_L_HAND)) return 'weapon';
  if (loc && !(loc & LOC_AMMO)) return 'armor';

  // No equip location at all: not equipment, so the type byte is all there is
  // and nothing here can be a costume.
  switch (Number(itemType)) {
    case 0:
    case 2:
    case 10:
      return 'usable';
    case 4:
      return 'armor';
    case 5:
    case 9:                     // two-handed weapon
      return 'weapon';
    case 6:
      return 'card';
    default:
      return 'etc';
  }
}

function setInvCategory(cat) {
  invCategory = cat;
  invSubCategory = 'all';
  lastRenderedInvSig = '';
  ['pillMainInv', 'pillMainCart', 'pillMainStorage', 'pillMainGuildStorage', 'pillMainLoot'].forEach(id => {
    const el = $(id);
    if (el) el.classList.remove('active');
  });
  if (cat === 'inventory' && $('pillMainInv')) $('pillMainInv').classList.add('active');
  if (cat === 'cart' && $('pillMainCart')) $('pillMainCart').classList.add('active');
  if (cat === 'storage' && $('pillMainStorage')) $('pillMainStorage').classList.add('active');
  if (cat === 'guild_storage' && $('pillMainGuildStorage')) $('pillMainGuildStorage').classList.add('active');
  if (cat === 'loot' && $('pillMainLoot')) $('pillMainLoot').classList.add('active');

  $('invTitle').textContent = cat === 'cart' ? 'Push Cart' : (cat === 'storage' ? 'Kafra Storage' : (cat === 'guild_storage' ? 'Guild Storage' : (cat === 'loot' ? 'Session Drops' : 'Character Inventory')));
  updateSubPills();
  updateInvSource();
}

function setSubCategory(sub) {
  invSubCategory = sub;
  lastRenderedInvSig = '';
  updateSubPills();
  renderInv();
}

function setSortMode(mode) {
  invSortMode = mode;
  lastRenderedInvSig = '';
  $('sortSlotBtn').classList.toggle('active', mode === 'slot');
  $('sortQtyBtn').classList.toggle('active', mode === 'qty');
  $('sortNameBtn').classList.toggle('active', mode === 'name');
  renderInv();
}

function updateSubPills() {
  const wrap = $('subPillsWrap');
  if (!wrap) return;
  
  if (invCategory === 'inventory') {
    wrap.style.display = 'flex';
    wrap.innerHTML = `
      <button class="pill-btn ${invSubCategory === 'all' ? 'active' : ''}" onclick="setSubCategory('all')">🌐 All</button>
      <button class="pill-btn ${invSubCategory === 'usable' ? 'active' : ''}" onclick="setSubCategory('usable')">🧪 Usable</button>
      <button class="pill-btn ${invSubCategory === 'equip' ? 'active' : ''}" onclick="setSubCategory('equip')">⚔️ Equip</button>
      <button class="pill-btn ${invSubCategory === 'etc' ? 'active' : ''}" onclick="setSubCategory('etc')">📦 Etc</button>
      <button class="pill-btn ${invSubCategory === 'fav' ? 'active' : ''}" onclick="setSubCategory('fav')">⭐ Fav</button>
    `;
  } else if (invCategory === 'storage' || invCategory === 'guild_storage') {
    wrap.style.display = 'flex';
    wrap.innerHTML = `
      <button class="pill-btn ${invSubCategory === 'all' ? 'active' : ''}" onclick="setSubCategory('all')">🌐 All</button>
      <button class="pill-btn ${invSubCategory === 'usable' ? 'active' : ''}" onclick="setSubCategory('usable')">🧪 Usable</button>
      <button class="pill-btn ${invSubCategory === 'weapon' ? 'active' : ''}" onclick="setSubCategory('weapon')">⚔️ Weapon</button>
      <button class="pill-btn ${invSubCategory === 'armor' ? 'active' : ''}" onclick="setSubCategory('armor')">🛡️ Armor</button>
      <button class="pill-btn ${invSubCategory === 'card' ? 'active' : ''}" onclick="setSubCategory('card')">🎴 Cards</button>
      <button class="pill-btn ${invSubCategory === 'costume' ? 'active' : ''}" onclick="setSubCategory('costume')">👑 Costume</button>
      <button class="pill-btn ${invSubCategory === 'etc' ? 'active' : ''}" onclick="setSubCategory('etc')">📦 Etc</button>
    `;
  } else {
    wrap.style.display = 'none';
  }
}

function updateInvSource() {
  if (!lastSnapshot) return;
  // The containers come from /inventory.json; the snapshot is only a fallback
  // for a server old enough to still be sending them inline.
  const inv = (lastInventoryKey === (selectedClientKey || '') && lastInventory) || {};
  const clientObj = (selectedClientKey && (lastSnapshot.clients || []).find(c => c.key === selectedClientKey)) || lastSnapshot;
  let raw = [];
  if (invCategory === 'cart') raw = inv.cart || clientObj.cart || [];
  else if (invCategory === 'storage') raw = inv.storage || clientObj.storage || [];
  else if (invCategory === 'guild_storage') raw = inv.guild_storage || clientObj.guild_storage || [];
  else if (invCategory === 'loot') {
    const l = inv.loot || clientObj.loot || lastSnapshot.loot || {};
    const lootList = l.items || l || [];
    raw = Array.isArray(lootList) ? lootList : Object.entries(lootList || {}).map(([itid, count]) => ({itid: Number(itid), count}));
  } else {
    raw = inv.inventory || clientObj.inventory || [];
  }

  currentInv = raw.slice();

  // Summary badge
  const count = currentInv.length;
  const totalItems = currentInv.reduce((sum, item) => sum + (Number(item.count) || 1), 0);
  if (invCategory === 'inventory') {
    const v = lastSnapshot.vitals || {};
    const wtStr = (v.weight != null && v.maxweight) ? ` · Weight: ${(v.weight/v.maxweight*100).toFixed(0)}%` : '';
    $('invCapacitySummary').textContent = `${count}/100 slots (${totalItems.toLocaleString()} items${wtStr})`;
  } else if (invCategory === 'cart') {
    $('invCapacitySummary').textContent = `${count}/100 slots (${totalItems.toLocaleString()} items)`;
  } else if (invCategory === 'storage' || invCategory === 'guild_storage') {
    $('invCapacitySummary').textContent = `${count} slots (${totalItems.toLocaleString()} items)`;
  } else if (invCategory === 'loot') {
    const l = lastSnapshot.loot || {};
    const rateStr = l.per_hour ? ` · ${n(l.per_hour)}/h` : '';
    $('invCapacitySummary').textContent = `${totalItems.toLocaleString()} drops (${count} unique${rateStr})`;
  }

  renderInv();
}

const OPTION_LABELS = {
  1: "MHP +%d", 2: "MSP +%d", 3: "STR +%d", 4: "AGI +%d", 5: "VIT +%d", 6: "INT +%d", 7: "DEX +%d", 8: "LUK +%d",
  9: "MHP +%d%%", 10: "MSP +%d%%", 11: "HP Recovery +%d%%", 12: "SP Recovery +%d%%", 13: "ATK +%d", 14: "ATK +%d%%",
  15: "MATK +%d", 16: "MATK +%d%%", 17: "DEF +%d", 18: "MDEF +%d", 19: "MATK +%d", 20: "Critical +%d",
  21: "Flee +%d", 22: "Hit +%d", 23: "Perfect Dodge +%d", 24: "Speed +%d%%", 25: "ASPD +%d", 26: "ASPD +%d%%",
  27: "Cast Time -%d%%", 28: "After-Cast Delay -%d%%", 29: "SP Consumption -%d%%", 30: "Ranged Damage +%d%%",
  31: "Heal +%d%%", 32: "Critical Damage +%d%%", 33: "Physical Melee Damage +%d%%"
};

function formatOption(opt) {
  if (!opt) return "";
  if (opt.text) return opt.text;
  const idx = Number(opt.index);
  const val = Number(opt.value) || 0;
  const fmt = OPTION_LABELS[idx];
  if (fmt) {
    return fmt.replace("%d", String(val));
  }
  return `Opt #${idx}: +${val}`;
}

function renderInv() {
  const container = $('invTable');
  const scrollWrap = $('invScrollContainer');
  if (!container) return;

  const query = ($('invSearch').value || '').trim().toLowerCase();

  // Filter by Sub-Category
  let list = currentInv.filter(item => {
    const cat = classifyItem(item.type, item.itid, item.name, item.location);
    if (invCategory === 'inventory') {
      if (invSubCategory === 'usable') return cat === 'usable';
      if (invSubCategory === 'equip') return cat === 'weapon' || cat === 'armor' || cat === 'costume';
      if (invSubCategory === 'etc') return cat === 'etc' || cat === 'card';
      if (invSubCategory === 'fav') return item.fav === 1 || item.favorite;
      return true;
    } else if (invCategory === 'storage' || invCategory === 'guild_storage') {
      if (invSubCategory === 'usable') return cat === 'usable';
      if (invSubCategory === 'weapon') return cat === 'weapon';
      if (invSubCategory === 'armor') return cat === 'armor';
      if (invSubCategory === 'card') return cat === 'card';
      if (invSubCategory === 'costume') return cat === 'costume';
      if (invSubCategory === 'etc') return cat === 'etc';
      return true;
    }
    return true;
  });

  // Filter by Search Query
  if (query) {
    list = list.filter(i => (i.name || `item#${i.itid}`).toLowerCase().includes(query) || String(i.itid).includes(query));
  }

  // Sort
  if (invSortMode === 'qty') {
    list.sort((a, b) => (Number(b.count) || 1) - (Number(a.count) || 1));
  } else if (invSortMode === 'name') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else {
    // In-game slot index sort
    list.sort((a, b) => (a.slot != null && b.slot != null) ? a.slot - b.slot : (a.name || '').localeCompare(b.name || ''));
  }

  // Signature check to prevent redundant redraws
  const sig = `${invCategory}_${invSubCategory}_${invSortMode}_${query}_${list.map(i => `${i.itid}:${i.count}:${i.slot}:${i.refine || 0}:${(i.cards || []).join('-')}:${(i.options || []).length}`).join(',')}`;
  if (sig === lastRenderedInvSig) return;
  lastRenderedInvSig = sig;

  // Preserve scroll position
  const prevScroll = scrollWrap ? scrollWrap.scrollTop : 0;

  if (!list.length) {
    container.innerHTML = `<tr><td colspan="3" style="color:var(--dim);text-align:center;padding:24px 0;">No items found in this section</td></tr>`;
    return;
  }

  container.innerHTML = list.map((i, idx) => {
    const itid = i.itid;
    let name = i.name || `Item #${itid}`;
    const count = Number(i.count) || 1;
    const slotNum = (i.slot != null) ? `#${i.slot}` : `#${idx + 1}`;
    const cat = classifyItem(i.type, itid, name, i.location);
    const refine = Number(i.refine) || 0;
    const grade = Number(i.grade) || 0;
    const cards = i.cards || [];
    const options = i.options || [];

    // Category tag style
    let tagHtml = '';
    if (cat === 'card') tagHtml = '<span style="font-size:9px;color:var(--gold);background:rgba(255,212,121,0.15);padding:1px 4px;border-radius:3px;margin-left:4px;">CARD</span>';
    else if (cat === 'weapon') tagHtml = '<span style="font-size:9px;color:var(--hp);background:rgba(255,85,85,0.15);padding:1px 4px;border-radius:3px;margin-left:4px;">WEAPON</span>';
    else if (cat === 'armor') tagHtml = '<span style="font-size:9px;color:var(--acc);background:rgba(127,209,255,0.15);padding:1px 4px;border-radius:3px;margin-left:4px;">ARMOR</span>';
    else if (cat === 'costume') tagHtml = '<span style="font-size:9px;color:#d88df0;background:rgba(216,141,240,0.15);padding:1px 4px;border-radius:3px;margin-left:4px;">COSTUME</span>';

    // Refine & Grade badges
    let refineBadge = (refine > 0) ? `<span class="refine-badge">+${refine}</span>` : '';
    let gradeBadge = (grade > 0) ? `<span class="grade-badge">Grade ${grade}</span>` : '';

    // If name already starts with "+X ", strip it for clean display with badge
    let cleanName = name;
    if (cleanName.startsWith(`+${refine} `)) {
      cleanName = cleanName.substring(`+${refine} `.length);
    }

    // Slotted cards chips
    let cardsHtml = '';
    if (cards.length > 0) {
      cardsHtml = `<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:2px;">` +
        cards.map(cId => `<span class="card-chip">🎴 Card #${cId}</span>`).join('') +
        `</div>`;
    }

    // Random Option chips
    let optionsHtml = '';
    if (options.length > 0) {
      optionsHtml = `<div class="opt-container">` +
        options.map(opt => `<span class="opt-chip">✨ ${formatOption(opt)}</span>`).join('') +
        `</div>`;
    }

    return `
      <tr>
        <td style="width:32px;color:var(--dim);font-size:10px;font-weight:700;text-align:center;">${slotNum}</td>
        <td>
          <div class="item-row">
            <img src="https://midgardhub.com/images/items/${itid}.png" onerror="this.onerror=null;this.src='https://midgardhub.com/images/items/${itid}.gif';" class="item-icon" alt="">
            <div style="min-width:0;flex:1;">
              <div style="display:flex;align-items:center;flex-wrap:wrap;">
                ${refineBadge}
                ${gradeBadge}
                <a href="https://midgardhub.com/database/items/${itid}" target="_blank" class="item-link">${cleanName}</a>
                ${tagHtml}
              </div>
              ${cardsHtml}
              ${optionsHtml}
            </div>
          </div>
        </td>
        <td style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:var(--fg);">${count.toLocaleString()}</td>
      </tr>
    `;
  }).join('');

  // Restore scroll position
  if (scrollWrap && prevScroll > 0) {
    scrollWrap.scrollTop = prevScroll;
  }
}

let selectedClientKey = null;

function selectClient(key) {
  selectedClientKey = key;
  lastInventory = null;
  lastInventoryKey = null;
  lastMap = null;
  lastMapKey = null;
  tick();
}

// --- Main Real-Time Tick ---
async function tick() {
  if (authBlocked) return;          // waiting on the pairing dialog
  if (!activeStreamUrl) {
    resolveAndConnect();
    return;
  }

  try {
    const clientParam = selectedClientKey ? `&client=${encodeURIComponent(selectedClientKey)}` : '';
    // lean=1 says this page fetches containers from /inventory.json and
    // the walked trail from /map.json, so the overlay can leave both out
    // of a payload it re-sends every second. Without the flag it sends
    // them inline, which is what keeps an older deployed portal working.
    const url = `${activeStreamUrl}/status.json?t=${Date.now()}&lean=1${clientParam}`;
    const res = await apiFetch(url);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        $('charLoc').textContent = 'PIN required';
        $('liveDot').classList.add('off');
        authBlocked = true;
        rePair();
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const d = await res.json();
    lastSnapshot = d;
    failedPolls = 0;
    $('liveDot').classList.remove('off');
    $('hdrBackend').textContent = (d.capture || {}).backend || 'LIVE';

    // Multi-Client / Multi-Character Support
    const clients = d.clients || [];
    const barEl = $('clientsBar');
    const fleetCardEl = $('fleetCard');
    if (clients.length > 1) {
      if (barEl) {
        barEl.style.display = 'flex';
        barEl.innerHTML = clients.map(cl => {
          const isAct = cl.active || (selectedClientKey && cl.key === selectedClientKey);
          return `<button class="client-pill ${isAct ? 'active' : ''}" onclick="selectClient('${cl.key}')">
            ${isAct ? '✓ ' : ''}${cl.name} (${cl.job} Lv ${cl.base_level ?? '-'})
          </button>`;
        }).join('');
      }
      if (fleetCardEl) {
        fleetCardEl.style.display = 'block';
        $('fleetCount').textContent = clients.length;
        $('fleetList').innerHTML = clients.map(cl => {
          const isAct = cl.active || (selectedClientKey && cl.key === selectedClientKey);
          const hpP = cl.maxhp > 0 ? ((cl.hp || 0) / cl.maxhp * 100) : 0;
          return `
            <div class="fleet-item ${isAct ? 'active' : ''}" onclick="selectClient('${cl.key}')">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <div style="font-weight:700; color:${isAct ? 'var(--acc)' : 'var(--fg)'}; font-size:13px;">
                  ${isAct ? '▶ ' : ''}${cl.name} <span style="font-weight:400; color:var(--dim); font-size:11px;">(${cl.job} Lv ${cl.base_level ?? '-'}/${cl.job_level ?? '-'})</span>
                </div>
                <div style="font-size:11px; font-weight:700; color:var(--good);">
                  ${cl.base_per_hour ? n(cl.base_per_hour) + '/h' : '0/h'}
                </div>
              </div>
              <div class="progress-bg" style="height:5px; margin-bottom:3px;"><div class="progress-fill" style="background:var(--hp); width:${Math.min(100, Math.max(0, hpP))}%;"></div></div>
              <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--dim);">
                <span>HP: ${cl.hp != null ? cl.hp.toLocaleString() : '-'}/${cl.maxhp != null ? cl.maxhp.toLocaleString() : '-'}</span>
                <span>Map: ${cl.map || '-'}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    } else {
      if (barEl) barEl.style.display = 'none';
      if (fleetCardEl) fleetCardEl.style.display = 'none';
    }

    const c = d.character || {}, e = d.exp || {}, v = d.vitals || {}, k = d.combat || {}, z = d.zeny || {}, l = d.loot || {};
    const charName = c.name || 'Character';
    const jobName = c.job || 'Novice';
    $('charName').textContent = `${charName}  •  ${jobName}`;

    const iconEl = $('charJobIcon');
    if (iconEl) {
      const jid = c.job_id != null ? c.job_id : 0;
      iconEl.src = `jobicons/icon_job_${jid}.png`;
      iconEl.style.display = 'block';
    }
    const loc = d.location || {};
    $('charLoc').textContent = loc.map ? `${loc.map} (${loc.x || 0}, ${loc.y || 0})` : 'in-game';

    // Vitals
    const hp = v.hp, maxhp = v.maxhp, sp = v.sp, maxsp = v.maxsp;
    const wt = v.weight, maxwt = v.maxweight;
    const hpPct = (hp != null && maxhp != null && maxhp > 0) ? (hp / maxhp * 100) : 0;
    const spPct = (sp != null && maxsp != null && maxsp > 0) ? (sp / maxsp * 100) : 0;
    const wtPct = (wt != null && maxwt != null && maxwt > 0) ? (wt / maxwt * 100) : 0;

    $('hpText').textContent = `${hp != null ? hp.toLocaleString() : '-'} / ${maxhp != null ? maxhp.toLocaleString() : '-'}`;
    $('spText').textContent = `${sp != null ? sp.toLocaleString() : '-'} / ${maxsp != null ? maxsp.toLocaleString() : '-'}`;
    $('wtText').textContent = `${wt != null ? wt.toLocaleString() : '-'} / ${maxwt != null ? maxwt.toLocaleString() : '-'}${wt != null && maxwt != null ? ` (${wtPct.toFixed(0)}%)` : ''}`;
    $('hpBar').style.width = Math.min(100, Math.max(0, hpPct)) + '%';
    $('spBar').style.width = Math.min(100, Math.max(0, spPct)) + '%';
    $('wtBar').style.width = Math.min(100, Math.max(0, wtPct)) + '%';

    // Alarms
    if (prevHp !== null && hp > 0 && maxhp > 0 && (hp / maxhp) <= 0.25 && (prevHp / maxhp) > 0.25) alarmLowHp();
    prevHp = hp;
    const baseLv = c.base_level;
    if (prevBaseLv !== null && typeof baseLv === 'number' && baseLv > prevBaseLv) alarmLevelUp();
    prevBaseLv = typeof baseLv === 'number' ? baseLv : prevBaseLv;

    // EXP
    $('blv').textContent = `Base Lv ${baseLv ?? '-'}`;
    $('jlv').textContent = `Job Lv ${c.job_level ?? '-'}`;
    $('bpct').textContent = e.base_pct != null ? e.base_pct.toFixed(2) + '%' : '0.00%';
    $('jpct').textContent = e.job_pct != null ? e.job_pct.toFixed(2) + '%' : '0.00%';
    $('bbar').style.width = (e.base_pct || 0) + '%';
    $('jbar').style.width = (e.job_pct || 0) + '%';
    $('bph').textContent = n(e.base_per_hour);
    $('jph').textContent = n(e.job_per_hour);
    $('expTnl').textContent = e.tnl_base != null ? `TNL: ${n(e.tnl_base)}` : '-';
    $('beta').textContent = dur(e.eta_base_sec);
    $('killsOverview').textContent = `${(k.kills ?? 0).toLocaleString()} kills`;

    // Zeny & Session
    $('zeny').textContent = n(z.held);
    $('zph').textContent = n(z.per_hour);
    const s = d.session || {};
    $('sessionTime').textContent = `Active ${dur(s.active_sec)} (Elapsed ${dur(s.elapsed_sec)})`;

    // Combat & Buffs
    $('dps').textContent = k.dps != null ? n(k.dps) + '/s' : '-';
    $('bestHit').textContent = n(k.best_hit);
    $('dmgDealt').textContent = n(k.damage_dealt);
    $('dmgTaken').textContent = n(k.damage_taken);

    const buffs = d.buffs || [];
    $('buffCount').textContent = buffs.length;
    $('buffsContainer').innerHTML = buffs.length ? buffs.map(b =>
      `<div class="buff-pill"><span class="acc">#${b.index}</span> <b>${b.remain_sec == null ? '∞' : b.remain_sec < 0 ? 'Perm' : Math.round(b.remain_sec)+'s'}</b></div>`
    ).join('') : '<span style="color:var(--dim)">No active buffs</span>';

    // Items, Inventory, Cart & Storage. The containers ride a slower request
    // of their own - every fifth tick, and only while their tab is on screen.
    if (activeTab === 'loot') {
      invTicks = (invTicks + 1) % 5;
      refreshInventory(invTicks === 0);
    }
    updateInvSource();

    // Map drawing with live actors and monsters. The player dot and the mobs
    // come from the snapshot every tick; the trail behind them is fetched on
    // its own, and only while the map is being looked at.
    if (activeTab === 'map') refreshMap();
    drawMap(loc, d.actors || d.monsters || []);

    // Chat
    const msgs = d.messages || [];
    if (msgs.length) {
      $('chatBox').innerHTML = msgs.slice(-25).reverse().map(m => {
        let prefix = '';
        if (m.channel === 'broadcast' || m.kind === 'broadcast') {
          const fromName = (m.from && m.from !== 'System') ? `${m.from} (Shout)` : 'Broadcast';
          prefix = `<span class="msg-bc">[${fromName}] </span>`;
        } else if (m.channel === 'self' || m.kind === 'self') {
          // Our own public line, marked so a log of one map's chatter is
          // readable at a glance.
          prefix = `<span class="msg-who">${m.from || 'You'} (you): </span>`;
        } else if (m.from) {
          prefix = `<span class="msg-who">${m.from}: </span>`;
        }
        return `<div class="msg-row">${prefix}${m.text || ''}</div>`;
      }).join('');
    }

  } catch(err) {
    $('liveDot').classList.add('off');
    failedPolls++;
    if (failedPolls >= 2) {
      $('charLoc').textContent = 'reconnecting…';
      resolveAndConnect();
    }
  }
}

// Initialize
updateSubPills();
if (getRoom()) {
  resolveAndConnect();
} else {
  $('pairModal').classList.add('show');
}
setInterval(tick, 2000);
