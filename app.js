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

// Text that came off the wire - a character name, a status description - on
// its way into innerHTML. It was being called in three places without ever
// having been defined, which threw the moment a kill breakdown was drawn.
const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

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
    // The live snapshot carries only its last hundred lines, which is a
    // chat box and not a day. Draw those straight away so the card is never
    // blank, then ask the archive for the whole day and take it if it has
    // more - it is the same lines, written as they arrived.
    setHistChatRows((lastSnapshot.messages || [])
      .concat(lastSnapshot.announcements || []));
    loadHistChatArchive(url, isoToday(), selectedHistoryChar);

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
      setHistChatRows((data.chat || []).concat(data.shouts || []));

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

// The chat card and the drop feed, redrawn together. Extracted from the poll
// so a filter change can redraw without waiting for the next tick.
function renderChat(d) {
  const wanted = CHAT_CHANNELS[chatChannel] || null;
  const all = d.messages || [];
  const msgs = wanted ? all.filter(m => wanted.includes(m.channel || m.kind)) : all;
  const box = $('chatBox');
  if (box) {
    box.innerHTML = msgs.length ? msgs.slice(-25).reverse().map(m => {
      let prefix = '';
      if (m.channel === 'broadcast' || m.kind === 'broadcast') {
        const fromName = (m.from && m.from !== 'System') ? `${m.from} (Shout)` : 'Broadcast';
        prefix = `<span class="msg-bc">[${escapeHtml(fromName)}] </span>`;
      } else if (m.channel === 'self' || m.kind === 'self') {
        prefix = `<span class="msg-who">${escapeHtml(m.from || 'You')} (you): </span>`;
      } else if (m.from) {
        prefix = `<span class="msg-who">${escapeHtml(m.from)}: </span>`;
      }
      return `<div class="msg-row">${prefix}${chatText(m.text, m.links)}</div>`;
    }).join('')
    : `<div style="color:var(--dim);text-align:center;padding:20px;">` +
      `${all.length ? 'Nothing on this channel yet' : 'No messages received'}</div>`;
  }

  // Drop announcements are their own feed. They are server-wide - every rare
  // costume any player finds - so mixing them into the chat box meant the
  // chat box was nothing but drops and the conversation was invisible.
  const drops = d.announcements || [];
  const dropCard = $('dropCard');
  if (dropCard) {
    dropCard.style.display = drops.length ? '' : 'none';
    if (drops.length) {
      $('dropCount').textContent = drops.length;
      $('dropBox').innerHTML = drops.slice(-40).reverse().map(m =>
        `<div class="msg-row msg-drop-row"><span class="msg-drop">[Drop] </span>` +
        `${chatText(m.text, m.links)}</div>`).join('');
    }
  }
}

// Chat channel filter, matching the overlay's own tabs.
let chatChannel = localStorage.getItem('rozChatChannel') || 'all';
const CHAT_CHANNELS = {
  public: ['public', 'chat', 'self'],
  whisper: ['whisper'],
  party: ['party'],
  guild: ['guild'],
  broadcast: ['broadcast'],
};

function setChatChannel(key) {
  chatChannel = key;
  try { localStorage.setItem('rozChatChannel', key); } catch (e) { /* private mode */ }
  const tabs = $('chatTabs');
  if (tabs) {
    [...tabs.children].forEach(b => b.classList.toggle(
      'active', (b.getAttribute('onclick') || '').includes(`'${key}'`)));
  }
  if (lastSnapshot) renderChat(lastSnapshot);
}

// --- The day's chat, on the History tab ------------------------------------
//
// Same rows, read back off disk instead of out of the live tracker: the
// overlay archives the conversation per character and the shouts once for the
// server, and /api/history hands both back for whichever day is selected.
// Today is served from the live snapshot instead, which since the overlay
// restores its own log at startup is the same day's lines either way.
//
// Drops get a pill of their own and stay out of "All", exactly as they do on
// the live tab - a server-wide feed buries a conversation.
const HIST_CHAT_CHANNELS = Object.assign({ announce: ['announce'] }, CHAT_CHANNELS);
let histChatChannel = 'all';
let histChatRows = [];

function setHistChatChannel(key) {
  histChatChannel = key;
  const tabs = $('histChatTabs');
  if (tabs) {
    [...tabs.children].forEach(b => b.classList.toggle(
      'active', (b.getAttribute('onclick') || '').includes(`'${key}'`)));
  }
  renderHistChat();
}

function isoToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Today's archive, if it is richer than the snapshot we already drew. Quiet
// on failure: today has no file at all until the overlay's first flush, and
// an empty answer must not wipe the lines already on screen.
async function loadHistChatArchive(url, dateStr, charName) {
  const have = histChatRows.length;
  try {
    const charParam = (charName && charName !== 'all')
      ? `&char=${encodeURIComponent(charName)}` : '';
    const res = await apiFetch(
      `${url}/api/history?date=${encodeURIComponent(dateStr)}${charParam}`);
    if (!res.ok) return;
    const data = await res.json();
    const rows = (data.chat || []).concat(data.shouts || []);
    if (rows.length > have) setHistChatRows(rows);
  } catch (e) { /* offline: the snapshot's lines stand */ }
}

function setHistChatRows(rows) {
  histChatRows = (rows || [])
    .filter(m => m && m.text)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  renderHistChat();
}

const HIST_BADGES = {
  whisper: ['[PM]', 'msg-who'],
  party: ['[Party]', 'msg-who'],
  guild: ['[Guild]', 'msg-who'],
  broadcast: ['[Shout]', 'msg-bc'],
  announce: ['[Drop]', 'msg-drop'],
  self: ['[Me]', 'msg-who'],
};

function renderHistChat() {
  const box = $('histChatBox');
  if (!box) return;
  const wanted = HIST_CHAT_CHANNELS[histChatChannel]
    || CHAT_CHANNELS[histChatChannel] || null;
  const rows = wanted
    ? histChatRows.filter(m => wanted.includes(m.channel || m.kind))
    : histChatRows.filter(m => (m.channel || m.kind) !== 'announce');
  const total = $('histChatTotal');
  if (total) total.textContent = `${rows.length.toLocaleString()} Lines`;
  if (!rows.length) {
    box.innerHTML = `<div style="color:var(--dim);text-align:center;padding:20px;">` +
      `${histChatRows.length ? 'Nothing on this channel that day' : 'No chat recorded'}</div>`;
    return;
  }
  // Newest first, and bounded: a busy day is thousands of lines and the
  // phone should not be asked to lay all of them out at once.
  box.innerHTML = rows.slice(-300).reverse().map(m => {
    const chan = m.channel || m.kind || 'public';
    const b = HIST_BADGES[chan];
    const badge = b ? `<span class="${b[1]}">${b[0]} </span>` : '';
    const who = (m.from && m.from !== 'System')
      ? `<span class="msg-who">${escapeHtml(m.from)}: </span>` : '';
    const t = m.time ? `<span class="msg-time">${escapeHtml(m.time)} </span>` : '';
    return `<div class="msg-row">${t}${badge}${who}${chatText(m.text, m.links)}</div>`;
  }).join('');
}

// Chat text, escaped, with item links drawn the way an inventory row is.
//
// ro_session sends the message with its links written as "<Name (options)>"
// and the parsed items beside it, each carrying the exact label it was
// written as - so a segment is matched by label rather than by counting
// brackets, which a player can type too.
//
// Escaping is not optional here. This is text other players wrote, and it
// used to reach innerHTML raw.
function chatText(text, links) {
  const byLabel = {};
  (links || []).forEach(it => { if (it && it.label) byLabel['<' + it.label + '>'] = it; });
  return String(text == null ? '' : text)
    .split(/(<[^<>\n]+>)/)
    .map(part => {
      const item = byLabel[part];
      if (item) return itemChip(item);
      const safe = escapeHtml(part);
      return (part.startsWith('<') && part.endsWith('>'))
        ? `<span class="msg-link">${safe}</span>` : safe;
    })
    .join('');
}

// One inline item: icon, a link into the database, its category tag and its
// random options - the same four things the inventory row shows.
function itemChip(item) {
  const itid = item.itid;
  const cat = classifyItem(item.type, itid, item.name, item.location);
  const t = itemTag(cat, item.location, item.type);
  const tag = t ? `<span style="font-size:9px;color:${t[1]};background:${t[2]};` +
                  `padding:0 3px;border-radius:3px;">${t[0]}</span>` : '';
  const opts = (item.options || []).map(o =>
    `<span class="opt-chip">${escapeHtml(formatOption(o))}</span>`).join('');
  return `<span class="chat-item">` +
    `<img src="https://midgardhub.com/images/items/${itid}.png" ` +
    `onerror="this.onerror=null;this.src='https://midgardhub.com/images/items/${itid}.gif';" ` +
    `class="item-icon" alt="">` +
    `<a href="https://midgardhub.com/database/items/${itid}" target="_blank" ` +
    `class="item-link">${escapeHtml(item.name || ('Item #' + itid))}</a>` +
    `${tag}${opts}</span>`;
}

// --- Party ---
//
// The party comes from five packets and only one of them carries a cell:
// the server sends a member's position to the members standing on the same
// map, which is exactly the set worth a dot. Everyone else keeps a name, a
// bar and the name of the map they are on.
let showTrail = localStorage.getItem('rozTrail') !== '0';

function toggleTrail() {
  showTrail = !showTrail;
  localStorage.setItem('rozTrail', showTrail ? '1' : '0');
  const btn = $('trailBtn');
  if (btn) btn.classList.toggle('active', showTrail);
  if (lastSnapshot) drawMap(lastSnapshot.location || {}, currentActors);
}

function renderParty(party) {
  currentParty = party || null;
  const card = $('partyCard'), list = $('partyList');
  if (!card || !list) return;
  const members = (party && party.members) || [];
  if (!members.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  $('partyName').textContent = (party && party.name) || 'Party';
  $('partyCount').textContent = members.length;
  list.innerHTML = members.map(m => {
    const colour = partyColour(m);
    const pct = m.hp_pct == null ? null : Math.max(0, Math.min(100, m.hp_pct));
    const where = m.online === false ? 'offline'
      : (m.x != null ? `${m.x}, ${m.y}` : (m.map || '-'));
    const bar = pct == null ? '' :
      `<div class="party-bar"><i style="width:${pct}%;background:${colour}"></i></div>`;
    const hp = (m.hp != null && m.maxhp) ? `${n(m.hp)} / ${n(m.maxhp)}` : '';
    return `<div class="party-row${m.self ? ' me' : ''}">
      <span class="party-pip" style="background:${colour}"></span>
      <div class="party-who">
        <div class="party-name">${m.leader ? '<b class="acc">*</b> ' : ''}${escapeHtml(m.name || '?')}${m.self ? ' <span class="dim">(you)</span>' : ''}</div>
        <div class="party-meta">${escapeHtml(where)}${hp ? '  ·  ' + hp : ''}</div>
      </div>
      ${bar}
      <span class="party-pct">${pct == null ? '-' : pct.toFixed(0) + '%'}</span>
    </div>`;
  }).join('');
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

// The eight facings, numbered the way the client numbers them: zero is
// north and they run counter-clockwise. Canvas y grows downward while map y
// grows north, so the y component is flipped where it is used.
const DIR_VEC = [[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1]];

// The game draws the player on its own minimap as an arrow rather than a dot,
// because a dot is one fact short: it says where you are and not which way
// you are about to walk. Until something has said which way that is - a step,
// or a turn on the spot - a dot is what is honest.
function drawFacing(g, x, y, dir, size, fill) {
  if (dir == null || !DIR_VEC[dir]) {
    g.strokeStyle = fill; g.fillStyle = fill; g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(x, y, size / 2, 0, Math.PI * 2); g.fill();
    return;
  }
  const v = DIR_VEC[dir], len = Math.hypot(v[0], v[1]);
  const ux = v[0] / len, uy = -v[1] / len, px = -uy, py = ux;
  const back = size * 0.78, wide = size * 0.62, notch = size * 0.2;
  g.beginPath();
  g.moveTo(x + ux * size, y + uy * size);
  g.lineTo(x - ux * back + px * wide, y - uy * back + py * wide);
  g.lineTo(x - ux * notch, y - uy * notch);
  g.lineTo(x - ux * back - px * wide, y - uy * back - py * wide);
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = '#10131a'; g.lineWidth = 1.2; g.stroke();
}

// Green, amber, red - and grey for a member who is offline or out of sight.
function partyColour(m) {
  if (m.online === false) return '#6f7688';
  if (m.hp_pct == null) return '#7fd1ff';
  return m.hp_pct >= 50 ? '#2ecc71' : (m.hp_pct >= 25 ? '#ffcc66' : '#ff4d4d');
}

let currentParty = null;

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
  if (trail.length > 1 && showTrail) {
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

  // Party members standing on this map, drawn under our own marker so ours
  // is never the one covered. A member somewhere else has a row in the party
  // card and nothing to draw here.
  ((currentParty && currentParty.members) || []).forEach(m => {
    if (m.self || m.x == null) return;
    const mx = (m.x + offX) / maxC * S;
    const my = (maxC - (m.y + offY)) / maxC * S;
    const colour = partyColour(m);
    g.fillStyle = colour; g.strokeStyle = '#10131a'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(mx, my, 5, 0, Math.PI * 2); g.fill(); g.stroke();
    g.font = '9px Segoe UI'; g.textAlign = 'left';
    g.fillStyle = '#10131a';
    g.fillText(m.name || '', mx + 8, my - 5);
    g.fillStyle = colour;
    g.fillText(m.name || '', mx + 7, my - 6);
  });

  // Draw the player, facing the way the character faces
  const px = (x + offX) / maxC * S;
  const py = (maxC - (y + offY)) / maxC * S;
  drawFacing(g, px, py, loc.dir, 9, '#ffd479');

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

  // Then by where it is worn. The RIGHT hand is what makes something a
  // weapon: a two-hander occupies both hands (0x22) and still has it.
  //
  // The left hand alone does not. That is where a shield goes - Buckler is
  // type 4 at location 0x20 - and treating either hand as a weapon was what
  // tagged every shield WEAPON. An off-hand slot is decided by the type
  // byte instead, which is the only thing separating a shield from a weapon
  // held in the off hand.
  if (loc & LOC_R_HAND) return 'weapon';
  if (loc & LOC_L_HAND) {
    const t = Number(itemType);
    return (t === 5 || t === 9) ? 'weapon' : 'armor';
  }
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

// One bit per place an item can be worn, so the badge is read off the wire
// rather than inferred. Order matters: the right hand is tested before the
// off hand, so a two-hander (0x22) is a WEAPON and not a SHIELD.
const EQUIP_SLOTS = [
  [0x000002, 'WEAPON'],
  [0x000020, 'SHIELD'],
  [0x000010, 'ARMOR'],
  [0x000301, 'HEADGEAR'],   // upper, mid and lower head, in one label
  [0x000004, 'GARMENT'],
  [0x000040, 'SHOES'],
  [0x000088, 'ACCESSORY'],  // left 0x08, right 0x80
  [0x008000, 'AMMO'],
];

const TAG_WEAPON = ['var(--hp)', 'rgba(255,85,85,0.15)'];
const TAG_GEAR = ['var(--acc)', 'rgba(127,209,255,0.15)'];
const TAG_COSTUME = ['#d88df0', 'rgba(216,141,240,0.15)'];
const TAG_SHADOW = ['#b48ce8', 'rgba(180,140,232,0.15)'];
const TAG_CARD = ['var(--gold)', 'rgba(255,212,121,0.15)'];
const TAG_AMMO = ['var(--dim)', 'rgba(150,150,150,0.15)'];

// [label, colour, background] for one item, or null for nothing worth showing.
//
// Colour stays coarse - one for weapons, one for everything else you wear -
// and only the word gets specific. Eight colours would be a rainbow on a
// list that is already dense; the reader wants to know it is a shield, not
// to learn a palette.
//
// Costume and shadow are tested before the slots because a costume headgear
// is a costume: it occupies its own bits and shares nothing with the real
// headgear slot.
function itemTag(cat, location, itemType) {
  const loc = Number(location) || 0;
  if (loc & LOC_SHADOW) return ['SHADOW', ...TAG_SHADOW];
  if (loc & LOC_COSTUME) return ['COSTUME', ...TAG_COSTUME];
  if (cat === 'card') return ['CARD', ...TAG_CARD];

  for (const [bit, label] of EQUIP_SLOTS) {
    if (!(loc & bit)) continue;
    // A weapon held in the off hand is still a weapon - the type byte is the
    // only thing that separates it from a shield.
    if (label === 'SHIELD') {
      const t = Number(itemType);
      if (t === 5 || t === 9) return ['WEAPON', ...TAG_WEAPON];
    }
    if (label === 'WEAPON') return [label, ...TAG_WEAPON];
    if (label === 'AMMO') return [label, ...TAG_AMMO];
    return [label, ...TAG_GEAR];
  }

  // No location at all: fall back to the coarse category.
  if (cat === 'weapon') return ['WEAPON', ...TAG_WEAPON];
  if (cat === 'armor') return ['ARMOR', ...TAG_GEAR];
  if (cat === 'costume') return ['COSTUME', ...TAG_COSTUME];
  return null;
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

// Random option wording.
//
// This used to be a hand-written table of the first 33 indices, and it was
// both short and wrong. Short: a level 4 weapon rolls indices up in the
// 140-180 range, so real rolls rendered as "Opt #170: +10". Wrong: index 17
// is ATK and index 20 is DEF, but the copy here had 17 as DEF and 24 as
// Speed, so the very same item read one way in the overlay and another way
// on the phone.
//
// The client's own table has all 255 of them and is re-extracted after every
// game patch, so it is fetched from the overlay rather than restated here.
// It is fetched once - it is ~12 KB and never changes while the overlay is
// running - and kept in localStorage so a reload renders correctly before
// the fetch lands, and still renders correctly with the overlay unreachable.
let OPTION_LABELS = {};
try {
  OPTION_LABELS = JSON.parse(localStorage.getItem('rozOptionLabels') || '{}');
} catch (e) { OPTION_LABELS = {}; }

// Which stream the table in hand came from, and the last one we asked.
// Both are needed because this runs once before anything is connected: on the
// published dashboard `activeStreamUrl` is still empty at that point, so the
// fetch went to the GitHub Pages origin, 404'd, and was never tried again -
// which is why every option on the phone stayed "Opt #170: +5" while the
// overlay had the name. The table has to be (re)fetched once the stream is
// known, and again if the page is pointed at a different overlay.
let optionsLoadedFor = null;
let optionsTriedFor = null;
let optionsTriedAt = 0;

async function loadOptionLabels() {
  const url = activeStreamUrl || window.location.origin;
  if (optionsLoadedFor === url) return;
  // Don't hammer an overlay too old to serve it: one attempt per URL per
  // 30s. A new URL is always tried at once, so connecting is never delayed.
  if (optionsTriedFor === url && Date.now() - optionsTriedAt < 30000) return;
  optionsTriedFor = url;
  optionsTriedAt = Date.now();
  try {
    const res = await apiFetch(`${url}/api/options`);
    if (!res.ok) return;
    const data = await res.json();
    const opts = data.options || {};
    if (!Object.keys(opts).length) return;
    OPTION_LABELS = opts;
    optionsLoadedFor = url;
    try { localStorage.setItem('rozOptionLabels', JSON.stringify(opts)); } catch (e) {}
    if (lastSnapshot) { try { renderChat(lastSnapshot); } catch (e) {} }
    try { renderInv(); } catch (e) {}
  } catch (e) { /* offline: the cached copy stands */ }
}

// printf the way Python's % does, because that is what wrote these strings:
// %d takes the value, %% is a literal percent. Doing it with a plain
// replace("%d", val) left the "%%" in "ATK +25%%" on the screen.
function formatOption(opt) {
  if (!opt) return "";
  if (opt.text) return opt.text;
  const idx = Number(opt.index);
  const val = Number(opt.value) || 0;
  const fmt = OPTION_LABELS[String(idx)];
  if (fmt === undefined || fmt === null) return `Opt #${idx}: +${val}`;
  // A few options carry no number at all - "Weapon element: Fire" is the
  // whole bonus - and are already finished text.
  if (fmt.indexOf('%') < 0) return fmt || `Opt #${idx}: +${val}`;
  return fmt.replace(/%(.)/g, (m, c) => {
    if (c === '%') return '%';
    if (c === 'd' || c === 'i' || c === 'u') return String(val);
    if (c === 's') return String(val);
    return m;
  });
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

    // Category tag: the equip slot when the item has one.
    const tg = itemTag(cat, i.location, i.type);
    const tagHtml = tg
      ? `<span style="font-size:9px;color:${tg[1]};background:${tg[2]};` +
        `padding:1px 4px;border-radius:3px;margin-left:4px;">${tg[0]}</span>`
      : '';

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
        options.map(opt => `<span class="opt-chip">✨ ${escapeHtml(formatOption(opt))}</span>`).join('') +
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
    // The stream answered, so we know where to ask for the option table and
    // that the PIN is accepted. No-ops once it has been fetched for this URL.
    loadOptionLabels();
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

    readBuffs(d.buffs || []);
    renderStats(d.stats);
    readSkills(d.skills);

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
    renderParty(d.party);
    drawMap(loc, d.actors || d.monsters || []);

    renderChat(d);
  } catch (err) {
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
// --- Character sheet & skills ---------------------------------------------
//
// Both come off the same snapshot as everything else on this tab. The sheet
// arrives whole once per map login and then one stat at a time; the session
// merges those, so what lands here is already a single consistent reading and
// this only has to lay it out.

const statNum = v => v == null ? '-'
  : (Math.round(v) === v ? v.toLocaleString() : v.toFixed(1));

function statLine(row, isPrimary) {
  const bonus = row.bonus;
  // A bonus of zero is not worth a "+0" - the game prints one, but it prints
  // it in a window that is not competing for room on a phone.
  const plus = bonus ? `<span class="b">+${statNum(bonus)}</span>` : '<span class="b"></span>';
  // Where the game puts its raise arrow: what the next point of this stat
  // costs in status points.
  const need = isPrimary
    ? `<span class="need">${row.need != null ? row.need : ''}</span>` : '';
  return `<div class="stat-line"><span class="k">${escapeHtml(row.label)}</span>` +
         `<span class="v">${statNum(row.value)}</span>${plus}${need}</div>`;
}

function renderStats(st) {
  const empty = $('statEmpty');
  const prim = $('statPrimary'), comb = $('statCombat');
  if (!st || !(st.primary || []).length) {
    // Not a zeroed sheet: a capture that started after this character's map
    // login has genuinely never been told what their Str is, and showing "0"
    // would be a lie the player could act on.
    prim.innerHTML = ''; comb.innerHTML = '';
    empty.style.display = 'block';
    $('statPoints').innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  prim.innerHTML = (st.primary || []).map(r => statLine(r, true)).join('');
  // The session orders these Atk, Def, Matk, Mdef, Hit, Flee, Critical, Aspd,
  // which is the game's own pairing once the grid puts two on a row.
  comb.innerHTML = (st.combat || []).map(r => statLine(r, false)).join('');
  const bits = [];
  if (st.status_points != null) bits.push(`Status Point <b>${st.status_points}</b>`);
  if (st.skill_points) bits.push(`Skill Point <b>${st.skill_points}</b>`);
  $('statPoints').innerHTML = bits.map(b => `<span>${b}</span>`).join('');
}

let skillFilter = 'all';
let lastSkills = [];

function setSkillFilter(f) {
  skillFilter = f;
  ['all', 'active', 'passive'].forEach(k => {
    const b = $('pillSkill' + k.charAt(0).toUpperCase() + k.slice(1));
    if (b) b.classList.toggle('active', k === f);
  });
  renderSkills();
}

function renderSkills() {
  const box = $('skillList');
  if (!box) return;
  const q = ($('skillSearch').value || '').trim().toLowerCase();
  const rows = lastSkills.filter(sk => {
    // passive is null on a client whose skill list uses the short entry form,
    // and an unknown is not a match for either filter's opposite.
    if (skillFilter === 'active' && sk.passive === true) return false;
    if (skillFilter === 'passive' && sk.passive !== true) return false;
    return !q || (sk.name || '').toLowerCase().includes(q);
  });
  $('skillCount').textContent = rows.length;
  if (!rows.length) {
    box.innerHTML = '<div style="color:var(--dim);text-align:center;padding:20px 10px;font-size:12px;">'
      + (lastSkills.length ? 'No skill matches that search'
         : 'No skill list seen yet<br><span style="font-size:11px;color:#50576a;">'
           + 'The server sends it at map login - change map or relog to fill this in</span>')
      + '</div>';
    return;
  }
  box.innerHTML = rows.map(sk => {
    // The client's own icon, named after the skill's SKID constant. A skill
    // the archive has no file for - or any machine with no game installed -
    // gets an empty square rather than a broken-image glyph.
    const icon = `<img class="skill-icon" src="${activeStreamUrl || ''}/skillicon.png?id=${sk.skid}"` +
                 ` alt="" onerror="this.style.visibility='hidden'">`;
    const maxed = sk.max_lv && sk.lv === sk.max_lv;
    const level = sk.max_lv
      ? `<b>${sk.lv}</b>/${sk.max_lv}`
      : `<b>${sk.lv != null ? sk.lv : '-'}</b>`;
    const meta = sk.passive === true ? 'passive' : (sk.sp ? `${sk.sp} SP` : '');
    return `<div class="skill-row${maxed ? ' maxed' : ''}">${icon}` +
           `<span class="skill-name">${escapeHtml(sk.name)}</span>` +
           `<span class="skill-meta">${meta}</span>` +
           `<span class="skill-lv">${level}</span></div>`;
  }).join('');
}

// Rebuilding the list every poll would drop whatever the reader had typed in
// the search box out from under them, so it is rebuilt only when the list
// itself changes - which is at map login and when a point is spent.
// null, not '': an empty list is a real signature, and starting on it
// meant the first poll matched and the empty-state message never drew.
let lastSkillSig = null;
function readSkills(skills) {
  const sig = (skills || []).map(sk => `${sk.skid}:${sk.lv}`).join(',');
  if (sig === lastSkillSig) return;
  lastSkillSig = sig;
  lastSkills = skills || [];
  renderSkills();
}

// --- Active statuses -------------------------------------------------------
//
// The snapshot says what is running and how much is left of it at the instant
// it was taken. Polls are two seconds apart and the tiles have to count down
// between them, so what is kept here is the wall-clock time each status ends
// at rather than the seconds that were left when it arrived, and the tick
// reads the clock instead of subtracting.
//
// The tiles are rebuilt only when the set of statuses changes. Rebuilding them
// every tick would shut whatever tooltip is open under the reader's finger,
// and a status that is one second shorter than it was is not a different
// status.
let buffModel = [];
let buffSig = '';

// "Increase Agility" -> "IA". What a tile shows when the client has no icon
// for the effect - about a third of them, and most of those are effects
// nobody will ever be under.
const buffAbbr = name => (name || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim()
  .split(/ +/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

// Under a minute the seconds are the whole story; over ten, they are noise
// that changes every tick. In between, both. dur() is the right wording for a
// row of text and too wide for a 44px tile.
const clock = s => {
  s = Math.max(0, Math.ceil(s));
  if (s >= 3600) return (s / 3600 | 0) + 'h' + String(s % 3600 / 60 | 0).padStart(2, '0');
  if (s >= 600) return (s / 60 | 0) + 'm';
  if (s >= 60) return (s / 60 | 0) + ':' + String(s % 60).padStart(2, '0');
  return s + 's';
};

function readBuffs(buffs) {
  const now = Date.now() / 1000;
  buffModel = (buffs || []).map(b => ({
    id: b.index,
    name: b.name || ('Status #' + b.index),
    desc: b.desc || [],
    icon: !!b.icon,
    // A permanent status reports -1; one sent by the short packet, which has
    // no duration field at all, reports nothing. Neither gets a countdown.
    perm: b.remain_sec != null && b.remain_sec < 0,
    untimed: b.remain_sec == null,
    ends: (b.remain_sec != null && b.remain_sec >= 0) ? now + b.remain_sec : null,
    total: b.total_sec || null,
  }));
  const sig = buffModel.map(b => b.id).join(',');
  if (sig !== buffSig) { buffSig = sig; paintBuffs(); }
  tickBuffs();
}

function paintBuffs() {
  const box = $('buffsContainer');
  if (!box) return;
  hideBuffTip();
  if (!buffModel.length) {
    box.className = '';
    box.innerHTML = '<span class="dim" style="color:var(--dim)">No active buffs</span>';
    return;
  }
  box.className = 'buff-grid';
  box.innerHTML = buffModel.map((b, i) => {
    // The badge sits under the picture rather than instead of it, so an icon
    // the overlay cannot produce - no client installed, or a name this patch
    // dropped - falls back by removing a single element.
    const art = b.icon
      ? '<img class="buff-img" src="' + (activeStreamUrl || '') + '/statusicon.png?i=' + b.id
        + '" alt="" onerror="this.remove()">'
      : '';
    return '<div class="buff-tile" tabindex="0" data-b="' + i + '">'
      + '<span class="buff-art"><span class="buff-abbr">'
      + escapeHtml(buffAbbr(b.name)) + '</span>' + art
      + '<span class="buff-drain"></span></span>'
      + '<span class="buff-left">-</span></div>';
  }).join('');
  box.querySelectorAll('.buff-tile').forEach(el => {
    el.addEventListener('mouseenter', () => showBuffTip(el));
    el.addEventListener('focus', () => showBuffTip(el));
    el.addEventListener('mouseleave', hideBuffTip);
    el.addEventListener('blur', hideBuffTip);
    // Phones have no hover, and the phone is what this page is mostly read on.
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      if (buffTipFor === el) hideBuffTip(); else showBuffTip(el);
    });
  });
}

// One floating tooltip for the whole grid, parked on the body and placed with
// fixed coordinates. A tooltip living inside its tile is 210px hanging off a
// 44px box: at the left or right edge of a phone it goes off screen, and any
// ancestor that scrolls clips it. This has neither problem.
let buffTipEl = null;
let buffTipFor = null;

function showBuffTip(el) {
  const b = buffModel[+el.dataset.b];
  if (!b) return;
  if (!buffTipEl) {
    buffTipEl = document.createElement('div');
    buffTipEl.className = 'buff-tip';
    document.body.appendChild(buffTipEl);
    document.addEventListener('click', hideBuffTip);
  }
  buffTipEl.innerHTML = '<b>' + escapeHtml(b.name) + '</b>'
    + (b.desc.length ? '<br>' + b.desc.map(escapeHtml).join('<br>') : '');
  buffTipEl.style.visibility = 'hidden';
  buffTipEl.style.display = 'block';
  const r = el.getBoundingClientRect();
  const t = buffTipEl.getBoundingClientRect();
  const margin = 8;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
  // Above the tile by preference, below it when there is no room above, and
  // pinned inside the viewport either way - a tile low on a phone screen would
  // otherwise put its tooltip below the fold, where the finger that opened it
  // cannot see it.
  let top = r.top - t.height - 6;
  if (top < margin) top = r.bottom + 6;
  top = Math.max(margin, Math.min(top, window.innerHeight - t.height - margin));
  buffTipEl.style.left = Math.round(left) + 'px';
  buffTipEl.style.top = Math.round(top) + 'px';
  buffTipEl.style.visibility = 'visible';
  buffTipFor = el;
}

function hideBuffTip() {
  if (buffTipEl) buffTipEl.style.display = 'none';
  buffTipFor = null;
}

function tickBuffs() {
  const box = $('buffsContainer');
  if (!box || !buffModel.length) return;
  const now = Date.now() / 1000;
  let live = 0;
  box.querySelectorAll('.buff-tile').forEach(el => {
    const b = buffModel[+el.dataset.b];
    if (!b) return;
    const left = b.ends == null ? null : b.ends - now;
    if (left != null && left <= 0) {
      // Gone before the next poll can say so. Hidden rather than removed: the
      // poll is the authority on what is running, and it is two seconds away.
      el.style.display = 'none';
      if (buffTipFor === el) hideBuffTip();
      return;
    }
    el.style.display = '';
    live++;
    const t = el.querySelector('.buff-left');
    t.textContent = b.untimed ? 'on' : b.perm ? '∞' : clock(left);
    t.classList.toggle('soon', left != null && left <= 10);
    // The wedge covers what has already elapsed, so it sweeps round to fill
    // the icon exactly as the status expires - the game's own reading, and
    // the opposite of what a bar showing time remaining would do. Statuses
    // with no duration have nothing to sweep and stay clear.
    const drain = el.querySelector('.buff-drain');
    const gone = (left != null && b.total)
      ? Math.min(1, Math.max(0, 1 - left / b.total)) : 0;
    drain.style.setProperty('--buff-drain-p', (gone * 100).toFixed(2) + '%');
    drain.classList.toggle('low', left != null && b.total && left <= 60);
  });
  const count = $('buffCount');
  if (count) count.textContent = live;
}

setInterval(tickBuffs, 1000);

// The trail button remembers its answer per browser, so the pill has to be
// set from that answer rather than from the markup's default.
(() => {
  const btn = $('trailBtn');
  if (btn) btn.classList.toggle('active', showTrail);
})();

setInterval(tick, 2000);

// The remembered chat channel has to be reflected in the tabs at load, or the
// pill says "All" while the box is filtered to whispers.
(function () {
  try { setChatChannel(chatChannel); } catch (e) { /* tabs not on this page */ }
})();

// The option table. Everything that draws an item - the inventory, the item
// links in chat, the history log - words its random options from it. This
// first call only lands when the page is served BY the overlay, where the
// page origin is already the right host; on the published dashboard nothing
// is connected yet, and the tick fetches it once the stream is up.
loadOptionLabels();
