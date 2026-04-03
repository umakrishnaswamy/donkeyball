'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ─── Data helpers ────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID();
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

async function loadData() {
  if (USE_UPSTASH) {
    try {
      const res = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', 'donkeyball'])
      });
      const json = await res.json();
      if (json.result) return JSON.parse(json.result);
    } catch (e) {
      console.error('[data] Upstash load failed:', e.message);
    }
    return { players: [], teams: [], bracket: null };
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[data] Failed to load data.json, starting fresh:', e.message);
  }
  return { players: [], teams: [], bracket: null };
}

async function saveData(data) {
  if (USE_UPSTASH) {
    try {
      await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', 'donkeyball', JSON.stringify(data)])
      });
    } catch (e) {
      console.error('[data] Upstash save failed:', e.message);
    }
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parseFormBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = {};
      for (const pair of body.split('&')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
        const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
        if (k) params[k] = v;
      }
      resolve(params);
    });
    req.on('error', () => resolve({}));
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function teamDisplay(team, players) {
  if (!team) return 'TBD';
  return team.players.map(pid => {
    const p = players.find(pl => pl.id === pid);
    return p ? p.name : '?';
  }).join(' & ') || team.name || 'TBD';
}

// ─── Bracket logic ────────────────────────────────────────────────────────────

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateBracket(teams) {
  const n = teams.length;
  if (n < 2) return null;
  const size = nextPow2(n);
  const slots = shuffle([...teams.map(t => t.id), ...Array(size - n).fill('BYE')]);

  const rounds = [];
  // Round 1
  const r1 = [];
  for (let i = 0; i < slots.length; i += 2) {
    const match = {
      id: uuid(),
      team1Id: slots[i],
      team2Id: slots[i + 1],
      winnerId: null,
      status: 'pending'
    };
    // Auto-advance byes
    if (slots[i] === 'BYE' && slots[i + 1] !== 'BYE') {
      match.winnerId = slots[i + 1];
      match.status = 'bye';
    } else if (slots[i + 1] === 'BYE' && slots[i] !== 'BYE') {
      match.winnerId = slots[i];
      match.status = 'bye';
    } else if (slots[i] === 'BYE' && slots[i + 1] === 'BYE') {
      match.winnerId = 'BYE';
      match.status = 'bye';
    }
    r1.push(match);
  }
  rounds.push(r1);

  // Subsequent rounds
  let prev = r1;
  while (prev.length > 1) {
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const match = {
        id: uuid(),
        team1Id: prev[i].winnerId || null,
        team2Id: prev[i + 1] ? (prev[i + 1].winnerId || null) : null,
        winnerId: null,
        status: 'pending'
      };
      // Auto-advance if both slots already filled by byes
      if (match.team1Id && match.team2Id && match.team1Id === 'BYE' && match.team2Id === 'BYE') {
        match.winnerId = 'BYE';
        match.status = 'bye';
      } else if (match.team1Id && match.team2Id === 'BYE') {
        match.winnerId = match.team1Id;
        match.status = 'bye';
      } else if (match.team2Id && match.team1Id === 'BYE') {
        match.winnerId = match.team2Id;
        match.status = 'bye';
      }
      next.push(match);
    }
    rounds.push(next);
    prev = next;
  }

  return { rounds };
}

function propagateBracket(bracket) {
  if (!bracket) return;
  for (let r = 0; r < bracket.rounds.length - 1; r++) {
    const round = bracket.rounds[r];
    const nextRound = bracket.rounds[r + 1];
    for (let m = 0; m < round.length; m += 2) {
      const nextMatchIdx = Math.floor(m / 2);
      if (nextMatchIdx >= nextRound.length) continue;
      const nm = nextRound[nextMatchIdx];
      nm.team1Id = round[m].winnerId || null;
      nm.team2Id = round[m + 1] ? (round[m + 1].winnerId || null) : null;
      // Auto-advance byes
      if (nm.team1Id === 'BYE' && nm.team2Id && nm.team2Id !== 'BYE') {
        nm.winnerId = nm.team2Id;
        nm.status = 'bye';
      } else if (nm.team2Id === 'BYE' && nm.team1Id && nm.team1Id !== 'BYE') {
        nm.winnerId = nm.team1Id;
        nm.status = 'bye';
      } else if (nm.team1Id !== nm.team1Id) {
        // no-op
      } else {
        // Reset winner if teams changed
        if (nm.status !== 'bye') {
          // keep winner only if teams haven't changed
        }
      }
    }
  }
}

// ─── Team name generator ──────────────────────────────────────────────────────

const TEAM_NAMES = [
  'Thunder Donkeys', 'Wild Asses', 'Blazing Burros', 'Iron Mules',
  'Lightning Kicks', 'Chaos Colts', 'Rampage Riders', 'Furious Hooves',
  'Stampede Squad', 'Dusty Dynamos', 'Sonic Stallions', 'Rebel Asses',
  'Turbo Tails', 'Neon Donkeys', 'Blaze Brigade', 'Galaxy Gallopers',
  'Phantom Foals', 'Crimson Kicks', 'Silver Spurs', 'Golden Hooves'
];

function pickTeamNames(count) {
  const shuffled = shuffle([...TEAM_NAMES]);
  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(shuffled[i % shuffled.length] + (i >= shuffled.length ? ` ${Math.floor(i / shuffled.length) + 1}` : ''));
  }
  return names;
}

// ─── HTML Pages ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function signupPage(data, status, playerName) {
  const count = data.players.length;
  let msgHtml = '';
  if (status === 'ok') {
    msgHtml = `<div class="message success">🎉 You're in! Welcome, ${escHtml(playerName)}!</div>`;
  } else if (status === 'dup') {
    msgHtml = `<div class="message error">⚠️ That name is already registered!</div>`;
  } else if (status === 'empty') {
    msgHtml = `<div class="message error">⚠️ Please enter your name.</div>`;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="240">
<title>Donkeyball Tournament - Sign Up</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: linear-gradient(135deg, #1a0a2e 0%, #16213e 40%, #0f3460 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .container {
    background: rgba(255,255,255,0.05);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 24px;
    padding: 48px 40px;
    max-width: 480px;
    width: 100%;
    text-align: center;
    box-shadow: 0 25px 60px rgba(0,0,0,0.5);
  }
  .emoji { font-size: 72px; margin-bottom: 16px; display: block; }
  h1 { color: #fff; font-size: 2rem; font-weight: 900; letter-spacing: -0.5px; margin-bottom: 8px; }
  .subtitle { color: #a0a0c0; font-size: 1rem; margin-bottom: 32px; }
  .player-count {
    display: inline-block;
    background: rgba(255,220,0,0.15);
    border: 1px solid rgba(255,220,0,0.3);
    color: #ffd700;
    padding: 8px 20px;
    border-radius: 999px;
    font-size: 0.9rem;
    font-weight: 600;
    margin-bottom: 32px;
  }
  .form-group { margin-bottom: 20px; text-align: left; }
  label { display: block; color: #c0c0e0; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  input[type="text"] {
    width: 100%; padding: 14px 18px;
    background: rgba(255,255,255,0.08);
    border: 2px solid rgba(255,255,255,0.15);
    border-radius: 12px; color: #fff; font-size: 1.1rem; outline: none; transition: border-color 0.2s;
  }
  input[type="text"]:focus { border-color: #ffd700; }
  input[type="text"]::placeholder { color: rgba(255,255,255,0.3); }
  .btn {
    width: 100%; padding: 16px;
    background: linear-gradient(135deg, #ffd700, #ff8c00);
    border: none; border-radius: 12px; color: #1a0a2e;
    font-size: 1.1rem; font-weight: 900; cursor: pointer;
    text-transform: uppercase; letter-spacing: 1px;
  }
  .btn:hover { opacity: 0.9; }
  .message { margin-top: 20px; padding: 14px 20px; border-radius: 10px; font-weight: 600; font-size: 0.95rem; }
  .message.success { background: rgba(0,255,100,0.15); border: 1px solid rgba(0,255,100,0.3); color: #00ff64; }
  .message.error { background: rgba(255,80,80,0.15); border: 1px solid rgba(255,80,80,0.3); color: #ff5050; }
</style>
</head>
<body>
<div class="container">
  <span class="emoji">🫏</span>
  <h1>DONKEYBALL TOURNAMENT</h1>
  <div class="player-count">${count} player${count !== 1 ? 's' : ''} registered</div>
  <form method="POST" action="/signup">
    <div class="form-group">
      <label for="nameInput">Your Name</label>
      <input type="text" id="nameInput" name="name" placeholder="Enter your name..." maxlength="50" autocomplete="off" required>
    </div>
    <button type="submit" class="btn">🫏 Join the Tournament</button>
  </form>
  ${msgHtml}
</div>
</body>
</html>`;
}

function adminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin — Donkeyball Tournament</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f0f2f5; color: #1a1a2e; }
  header {
    background: linear-gradient(135deg, #1a0a2e, #0f3460);
    color: #fff;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.3);
  }
  header h1 { font-size: 1.3rem; font-weight: 900; }
  header span { font-size: 1.5rem; }
  .tabs {
    display: flex;
    background: #fff;
    border-bottom: 2px solid #e0e0e0;
    padding: 0 24px;
    gap: 4px;
  }
  .tab-btn {
    padding: 14px 24px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 600;
    color: #666;
    border-bottom: 3px solid transparent;
    margin-bottom: -2px;
    transition: all 0.2s;
  }
  .tab-btn.active { color: #0f3460; border-bottom-color: #0f3460; }
  .tab-btn:hover { color: #0f3460; }
  .tab-content { display: none; padding: 24px; max-width: 1100px; margin: 0 auto; }
  .tab-content.active { display: block; }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 20px 24px;
    margin-bottom: 20px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    border: 1px solid #e8e8f0;
  }
  .card h2 { font-size: 1rem; font-weight: 700; color: #1a1a2e; margin-bottom: 16px; }
  .input-row { display: flex; gap: 10px; margin-bottom: 16px; }
  input[type="text"] {
    flex: 1;
    padding: 10px 14px;
    border: 2px solid #e0e0e0;
    border-radius: 8px;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s;
  }
  input[type="text"]:focus { border-color: #0f3460; }
  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .btn-primary { background: #0f3460; color: #fff; }
  .btn-primary:hover { background: #1a4a80; }
  .btn-success { background: #00b074; color: #fff; }
  .btn-success:hover { background: #00c884; }
  .btn-danger { background: #ff4d4d; color: #fff; }
  .btn-danger:hover { background: #ff3333; }
  .btn-warning { background: #ff8c00; color: #fff; }
  .btn-warning:hover { background: #ff9f1c; }
  .btn-sm { padding: 6px 12px; font-size: 0.8rem; }
  .player-list { list-style: none; }
  .player-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 6px;
    background: #f7f8fc;
    border: 1px solid #eaeaf5;
  }
  .player-name { font-weight: 600; }
  .player-meta { color: #888; font-size: 0.8rem; }
  .teams-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }
  .team-card {
    background: #f7f8fc;
    border: 2px solid #e0e0f0;
    border-radius: 12px;
    padding: 16px;
  }
  .team-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .team-name-input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid #d0d0e0;
    border-radius: 6px;
    font-weight: 700;
    font-size: 0.95rem;
    background: #fff;
  }
  .team-players { list-style: none; }
  .team-player-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    background: #fff;
    border-radius: 6px;
    margin-bottom: 5px;
    border: 1px solid #eaeaf0;
    font-size: 0.9rem;
  }
  .move-select {
    padding: 4px 8px;
    border: 1px solid #d0d0e0;
    border-radius: 5px;
    font-size: 0.8rem;
    background: #fff;
    cursor: pointer;
  }
  .section-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
  .bracket-grid {
    display: flex;
    gap: 0;
    overflow-x: auto;
    padding-bottom: 12px;
  }
  .bracket-round {
    display: flex;
    flex-direction: column;
    min-width: 220px;
  }
  .round-label {
    text-align: center;
    font-weight: 700;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    padding: 8px 0;
    border-bottom: 2px solid #e0e0e0;
    margin-bottom: 12px;
  }
  .match-slot {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
  }
  .match-card {
    background: #fff;
    border: 2px solid #e0e0f0;
    border-radius: 10px;
    padding: 12px;
    width: 100%;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .match-card.completed { border-color: #00b074; }
  .match-card.bye { border-color: #ccc; opacity: 0.7; }
  .match-team {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .match-team.winner { background: rgba(0,176,116,0.15); color: #007a52; }
  .match-team.loser { opacity: 0.5; }
  .match-team.tbd { color: #aaa; font-style: italic; }
  .winner-select {
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid #d0d0e0;
    border-radius: 6px;
    font-size: 0.8rem;
    background: #fff;
    cursor: pointer;
  }
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1a1a2e;
    color: #fff;
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 600;
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s;
    z-index: 9999;
    pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.success { border-left: 4px solid #00b074; }
  .toast.error { border-left: 4px solid #ff4d4d; }
  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: #aaa;
  }
  .empty-state .big { font-size: 3rem; margin-bottom: 12px; }
  .links-bar {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    padding: 0 24px 8px;
    background: #fff;
  }
  .links-bar a {
    color: #0f3460;
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 4px 12px;
    border: 1px solid #cdd;
    border-radius: 999px;
  }
  .links-bar a:hover { background: #f0f4ff; }
  .badge {
    display: inline-block;
    background: #0f3460;
    color: #fff;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 2px 8px;
    margin-left: 6px;
  }
</style>
</head>
<body>
<header>
  <span>🫏</span>
  <h1>DONKEYBALL — Admin Panel</h1>
</header>
<div class="links-bar">
  <a href="/signup" target="_blank">Signup Page</a>
  <a href="/tv" target="_blank">TV Display</a>
</div>
<div class="tabs">
  <button class="tab-btn active" onclick="switchTab('players')">Players <span class="badge" id="playerBadge">0</span></button>
  <button class="tab-btn" onclick="switchTab('teams')">Teams <span class="badge" id="teamBadge">0</span></button>
  <button class="tab-btn" onclick="switchTab('bracket')">Bracket</button>
</div>

<!-- Players Tab -->
<div id="tab-players" class="tab-content active">
  <div class="card">
    <h2>Add Player</h2>
    <div class="input-row">
      <input type="text" id="addPlayerName" placeholder="Player name..." maxlength="50">
      <button class="btn btn-primary" onclick="addPlayer()">+ Add Player</button>
    </div>
  </div>
  <div class="card">
    <h2>Registered Players</h2>
    <ul class="player-list" id="playerList">
      <li class="empty-state"><div class="big">👤</div>No players yet. Share the signup link!</li>
    </ul>
  </div>
</div>

<!-- Teams Tab -->
<div id="tab-teams" class="tab-content">
  <div class="section-actions">
    <button class="btn btn-success" onclick="generateTeams()">🎲 Auto-Generate Teams</button>
  </div>
  <div id="teamsContainer">
    <div class="empty-state"><div class="big">👥</div>No teams yet. Click "Auto-Generate Teams" to get started.</div>
  </div>
</div>

<!-- Bracket Tab -->
<div id="tab-bracket" class="tab-content">
  <div class="section-actions">
    <button class="btn btn-warning" onclick="generateBracket()">🏆 Generate Bracket</button>
  </div>
  <div id="bracketContainer">
    <div class="empty-state"><div class="big">🏆</div>No bracket yet. Generate teams first, then create the bracket.</div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let state = { players: [], teams: [], bracket: null };

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    b.classList.toggle('active', ['players','teams','bracket'][i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 2800);
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    state = await res.json();
    renderPlayers();
    renderTeams();
    renderBracket();
    document.getElementById('playerBadge').textContent = state.players.length;
    document.getElementById('teamBadge').textContent = state.teams.length;
  } catch(e) {
    showToast('Failed to load state', 'error');
  }
}

function getTeamName(id) {
  if (!id || id === 'BYE') return id || 'TBD';
  const t = state.teams.find(t => t.id === id);
  return t ? t.name : 'Unknown';
}

function getPlayerName(id) {
  const p = state.players.find(p => p.id === id);
  return p ? p.name : 'Unknown';
}

function renderPlayers() {
  const ul = document.getElementById('playerList');
  if (!state.players.length) {
    ul.innerHTML = '<li class="empty-state"><div class="big">👤</div>No players yet. Share the signup link!</li>';
    return;
  }
  ul.innerHTML = state.players.map(p => \`
    <li class="player-item">
      <div>
        <div class="player-name">\${escHtml(p.name)}</div>
        <div class="player-meta">\${new Date(p.createdAt).toLocaleString()}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removePlayer('\${p.id}')">Remove</button>
    </li>
  \`).join('');
}

function renderTeams() {
  const c = document.getElementById('teamsContainer');
  if (!state.teams.length) {
    c.innerHTML = '<div class="empty-state"><div class="big">👥</div>No teams yet. Click "Auto-Generate Teams" to get started.</div>';
    return;
  }
  c.innerHTML = '<div class="teams-grid">' + state.teams.map(team => {
    const playerOptions = state.teams.map(t =>
      t.id !== team.id ? \`<option value="\${t.id}">\${escHtml(t.name)}</option>\` : ''
    ).join('');
    const players = team.players.map(pid => {
      const p = state.players.find(pl => pl.id === pid);
      return p ? \`
        <li class="team-player-item">
          <span>\${escHtml(p.name)}</span>
          <select class="move-select" onchange="movePlayer('\${pid}', '\${team.id}', this.value); this.value=''">
            <option value="">Move to...</option>
            \${playerOptions}
          </select>
        </li>
      \` : '';
    }).join('');
    const displayName = team.players.map(pid => { const p = state.players.find(pl => pl.id === pid); return p ? p.name : null; }).filter(Boolean).join(' & ') || team.name;
    return \`
      <div class="team-card">
        <div class="team-header">
          <span style="font-weight:700;font-size:1rem;">\${escHtml(displayName)}</span>
        </div>
        <ul class="team-players">\${players || '<li style="color:#aaa;font-size:0.85rem;padding:6px">No players</li>'}</ul>
      </div>
    \`;
  }).join('') + '</div>';
}

function getPlayerNames(team) {
  if (!team) return 'TBD';
  return team.players.map(pid => { const p = state.players.find(pl => pl.id === pid); return p ? p.name : '?'; }).filter(Boolean).join(' & ') || team.name || 'TBD';
}
function renderBracket() {
  const c = document.getElementById('bracketContainer');
  if (!state.bracket || (!state.bracket.table1 && !state.bracket.table2)) {
    c.innerHTML = '<div class="empty-state"><div class="big">🏆</div>No bracket yet. Generate teams first, then create the bracket.</div>';
    return;
  }
  const tables = [
    { key: 'table1', label: 'Table 1' },
    { key: 'table2', label: 'Table 2' }
  ].filter(t => state.bracket[t.key] && state.bracket[t.key].rounds.length);
  c.innerHTML = tables.map(({ key, label }) => {
    const bracket = state.bracket[key];
    const rounds = bracket.rounds;
    const roundNames = rounds.map((_, i) => {
      if (i === rounds.length - 1) return 'Finals';
      if (i === rounds.length - 2 && rounds.length > 2) return 'Semifinals';
      return 'Round ' + (i + 1);
    });
    const finalMatch = rounds[rounds.length - 1][0];
    const champion = finalMatch && finalMatch.winnerId && finalMatch.winnerId !== 'BYE'
      ? getPlayerNames(state.teams.find(t => t.id === finalMatch.winnerId))
      : null;
    return \`<div class="bracket-section">
      <h3 style="margin-bottom:12px;color:#0f3460;">🏓 \${label}\${champion ? ' — Champion: ' + escHtml(champion) : ''}</h3>
      <div style="display:flex;gap:16px;overflow-x:auto;">
        \${rounds.map((round, ri) => \`
          <div style="min-width:200px;">
            <div style="font-size:0.75rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">\${roundNames[ri]}</div>
            \${round.map(match => {
              const t1 = state.teams.find(t => t.id === match.team1Id);
              const t2 = state.teams.find(t => t.id === match.team2Id);
              const n1 = match.team1Id === 'BYE' ? 'BYE' : (t1 ? getPlayerNames(t1) : 'TBD');
              const n2 = match.team2Id === 'BYE' ? 'BYE' : (t2 ? getPlayerNames(t2) : 'TBD');
              const isBye = match.status === 'bye';
              const isDone = match.status === 'completed';
              const canPlay = !isDone && !isBye && match.team1Id && match.team2Id && match.team1Id !== 'BYE' && match.team2Id !== 'BYE';
              return \`<div style="border:1px solid #e0e0e0;border-radius:8px;padding:10px;margin-bottom:8px;background:\${isDone ? '#f0fff0' : '#fff'}">
                <div style="font-size:0.8rem;font-weight:\${match.winnerId === match.team1Id ? '700' : '400'};\${match.winnerId === match.team1Id ? 'color:#22c55e' : ''}">\${escHtml(n1)}</div>
                <div style="font-size:0.7rem;color:#aaa;margin:2px 0;">vs</div>
                <div style="font-size:0.8rem;font-weight:\${match.winnerId === match.team2Id ? '700' : '400'};\${match.winnerId === match.team2Id ? 'color:#22c55e' : ''}">\${escHtml(n2)}</div>
                \${canPlay ? \`<div style="margin-top:8px;display:flex;gap:4px;">
                  <button class="btn btn-sm btn-success" onclick="setWinner('\${match.id}','\${match.team1Id}')">✓ \${escHtml(n1.split(' & ')[0])}</button>
                  <button class="btn btn-sm btn-success" onclick="setWinner('\${match.id}','\${match.team2Id}')">✓ \${escHtml(n2.split(' & ')[0])}</button>
                </div>\` : ''}
                \${isDone ? \`<div style="font-size:0.7rem;color:#22c55e;margin-top:4px;">Winner: \${escHtml(match.winnerId === match.team1Id ? n1 : n2)}</div>\` : ''}
              </div>\`;
            }).join('')}
          </div>
        \`).join('')}
      </div>
    </div>\`;
  }).join('<hr style="margin:24px 0;">');
}

function renderMatchCard(match, isFinal) {
  const t1 = match.team1Id;
  const t2 = match.team2Id;
  const t1Name = t1 ? (t1 === 'BYE' ? 'BYE' : getTeamName(t1)) : 'TBD';
  const t2Name = t2 ? (t2 === 'BYE' ? 'BYE' : getTeamName(t2)) : 'TBD';
  const isComplete = match.status === 'completed' || match.status === 'bye';
  const isBye = match.status === 'bye';

  const t1Class = match.winnerId === t1 ? 'winner' : (match.winnerId ? 'loser' : (t1 ? '' : 'tbd'));
  const t2Class = match.winnerId === t2 ? 'winner' : (match.winnerId ? 'loser' : (t2 ? '' : 'tbd'));

  const canSelect = !isBye && t1 && t2 && t1 !== 'BYE' && t2 !== 'BYE';
  const selectHtml = canSelect ? \`
    <select class="winner-select" onchange="setWinner('\${match.id}', this.value)">
      <option value="">-- Select Winner --</option>
      \${t1 ? \`<option value="\${t1}" \${match.winnerId===t1?'selected':''}>\${escHtml(t1Name)}</option>\` : ''}
      \${t2 ? \`<option value="\${t2}" \${match.winnerId===t2?'selected':''}>\${escHtml(t2Name)}</option>\` : ''}
    </select>
  \` : (isBye ? '<div style="font-size:0.75rem;color:#aaa;margin-top:6px;text-align:center">BYE — Auto-advance</div>' : '');

  return \`
    <div class="match-slot">
      <div class="match-card \${isComplete && !isBye ? 'completed' : ''} \${isBye ? 'bye' : ''}">
        <div class="match-team \${t1Class}">\${escHtml(t1Name)} \${match.winnerId===t1 ? '🏆' : ''}</div>
        <div style="text-align:center;font-size:0.7rem;color:#aaa;margin:2px 0">vs</div>
        <div class="match-team \${t2Class}">\${escHtml(t2Name)} \${match.winnerId===t2 ? '🏆' : ''}</div>
        \${selectHtml}
      </div>
    </div>
  \`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function addPlayer() {
  const input = document.getElementById('addPlayerName');
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/players', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name})
  });
  const data = await res.json();
  if (res.ok) {
    showToast('Player added: ' + name);
    input.value = '';
    await loadState();
  } else {
    showToast(data.error || 'Error adding player', 'error');
  }
}

async function removePlayer(id) {
  if (!confirm('Remove this player?')) return;
  const res = await fetch('/api/players/' + id, {method: 'DELETE'});
  if (res.ok) {
    showToast('Player removed');
    await loadState();
  } else {
    showToast('Error removing player', 'error');
  }
}

async function generateTeams() {
  if (state.players.length < 2) {
    showToast('Need at least 2 players to generate teams', 'error');
    return;
  }
  const res = await fetch('/api/teams/generate', {method: 'POST'});
  const data = await res.json();
  if (res.ok) {
    showToast('Teams generated!');
    await loadState();
    switchTab('teams');
  } else {
    showToast(data.error || 'Error generating teams', 'error');
  }
}

async function renameTeam(id, name) {
  if (!name.trim()) return;
  const team = state.teams.find(t => t.id === id);
  if (!team || team.name === name.trim()) return;
  const res = await fetch('/api/teams/' + id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name: name.trim(), players: team.players})
  });
  if (res.ok) {
    showToast('Team renamed');
    await loadState();
  } else {
    showToast('Error renaming team', 'error');
  }
}

async function movePlayer(playerId, fromTeamId, toTeamId) {
  if (!toTeamId) return;
  const res = await fetch('/api/teams/swap', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({playerId, fromTeamId, toTeamId})
  });
  if (res.ok) {
    showToast('Player moved!');
    await loadState();
  } else {
    const d = await res.json();
    showToast(d.error || 'Error moving player', 'error');
  }
}

async function generateBracket() {
  if (state.teams.length < 2) {
    showToast('Need at least 2 teams to generate bracket', 'error');
    return;
  }
  if (!confirm('This will reset the current bracket. Continue?')) return;
  const res = await fetch('/api/bracket/generate', {method: 'POST'});
  const data = await res.json();
  if (res.ok) {
    showToast('Bracket generated!');
    await loadState();
    switchTab('bracket');
  } else {
    showToast(data.error || 'Error generating bracket', 'error');
  }
}

async function setWinner(matchId, winnerId) {
  if (!winnerId) return;
  const res = await fetch('/api/bracket/match/' + matchId, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({winnerId})
  });
  if (res.ok) {
    showToast('Winner set!');
    await loadState();
  } else {
    const d = await res.json();
    showToast(d.error || 'Error setting winner', 'error');
  }
}

document.getElementById('addPlayerName').addEventListener('keydown', e => {
  if (e.key === 'Enter') addPlayer();
});

loadState();
</script>
</body>
</html>`;
}

function tvPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DONKEYBALL TOURNAMENT 🫏</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    background: #000;
    color: #fff;
    font-family: 'Segoe UI', 'Arial Black', system-ui, sans-serif;
    overflow: hidden;
  }
  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  header {
    text-align: center;
    padding: 14px 20px 10px;
    background: linear-gradient(180deg, #0a0a0a 0%, #000 100%);
    border-bottom: 3px solid #c8ff00;
    flex-shrink: 0;
  }
  header h1 {
    font-size: clamp(1.6rem, 4vw, 3rem);
    font-weight: 900;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: #c8ff00;
    text-shadow: 0 0 30px rgba(200,255,0,0.6), 0 0 60px rgba(200,255,0,0.3);
  }
  .subtitle {
    font-size: clamp(0.7rem, 1.5vw, 1rem);
    color: rgba(200,255,0,0.6);
    letter-spacing: 4px;
    text-transform: uppercase;
    margin-top: 4px;
  }
  .bracket-area {
    flex: 1;
    display: flex;
    align-items: stretch;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 16px 12px;
    gap: 0;
    min-height: 0;
  }
  .no-bracket {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.3);
  }
  .no-bracket .big { font-size: 5rem; margin-bottom: 16px; }
  .no-bracket p { font-size: 1.2rem; letter-spacing: 2px; text-transform: uppercase; }
  .round-col {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 180px;
    max-width: 280px;
    position: relative;
  }
  .round-label {
    text-align: center;
    font-size: clamp(0.6rem, 1.2vw, 0.85rem);
    font-weight: 900;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: rgba(200,255,0,0.7);
    padding: 6px 0 10px;
    border-bottom: 1px solid rgba(200,255,0,0.2);
    margin: 0 8px 8px;
    flex-shrink: 0;
  }
  .matches-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-around;
    padding: 4px 8px;
    min-height: 0;
  }
  .match-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    position: relative;
  }
  .match-box {
    background: #0d0d0d;
    border: 2px solid rgba(255,255,255,0.12);
    border-radius: 10px;
    padding: 10px 12px;
    width: 100%;
    transition: border-color 0.3s, box-shadow 0.3s;
    position: relative;
  }
  .match-box.active {
    border-color: #c8ff00;
    box-shadow: 0 0 20px rgba(200,255,0,0.25), inset 0 0 20px rgba(200,255,0,0.04);
  }
  .match-box.completed {
    border-color: rgba(200,255,0,0.35);
  }
  .match-box.bye {
    border-color: rgba(255,255,255,0.06);
    opacity: 0.5;
  }
  .team-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 6px;
    transition: all 0.3s;
    min-height: 36px;
  }
  .team-row .team-name {
    flex: 1;
    font-size: clamp(0.7rem, 1.4vw, 1rem);
    font-weight: 700;
    letter-spacing: 0.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .team-row .trophy { font-size: 1rem; }
  .team-row.winner {
    background: rgba(200,255,0,0.15);
    color: #c8ff00;
  }
  .team-row.loser {
    opacity: 0.35;
    color: #888;
  }
  .team-row.tbd { color: rgba(255,255,255,0.25); font-style: italic; }
  .team-row.bye-team { color: rgba(255,255,255,0.2); font-style: italic; font-size: 0.8rem; }
  .vs-divider {
    text-align: center;
    font-size: 0.65rem;
    color: rgba(255,255,255,0.2);
    font-weight: 900;
    letter-spacing: 2px;
    margin: 2px 0;
  }
  .match-status-badge {
    position: absolute;
    top: -9px;
    right: 10px;
    font-size: 0.6rem;
    font-weight: 900;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .status-pending { background: rgba(255,255,255,0.12); color: #888; }
  .status-active { background: #c8ff00; color: #000; }
  .status-completed { background: rgba(200,255,0,0.25); color: #c8ff00; }
  .status-bye { background: rgba(255,255,255,0.07); color: #555; }
  .connector {
    position: absolute;
    right: -8px;
    top: 50%;
    width: 8px;
    height: 2px;
    background: rgba(200,255,0,0.3);
    transform: translateY(-50%);
  }
  footer {
    text-align: center;
    padding: 8px;
    font-size: 0.7rem;
    color: rgba(255,255,255,0.2);
    letter-spacing: 2px;
    flex-shrink: 0;
    border-top: 1px solid rgba(255,255,255,0.06);
  }
  #refreshDot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #c8ff00;
    margin-right: 6px;
    vertical-align: middle;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.2; }
  }
  .champion-banner {
    text-align: center;
    padding: 8px 20px;
    background: linear-gradient(135deg, rgba(200,255,0,0.1), rgba(200,255,0,0.05));
    border-bottom: 1px solid rgba(200,255,0,0.2);
    flex-shrink: 0;
    display: none;
  }
  .champion-banner.show { display: block; }
  .champion-name {
    font-size: clamp(1.2rem, 3vw, 2rem);
    font-weight: 900;
    color: #c8ff00;
    letter-spacing: 2px;
    text-shadow: 0 0 20px rgba(200,255,0,0.5);
  }
  .champion-label {
    font-size: 0.75rem;
    color: rgba(200,255,0,0.5);
    letter-spacing: 4px;
    text-transform: uppercase;
  }
  .dual-bracket {
    display: flex;
    gap: 0;
    height: 100%;
    width: 100%;
  }
  .table-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid rgba(255,255,255,0.08);
    padding: 8px;
  }
  .table-section:last-child { border-right: none; }
  .table-label {
    font-size: clamp(0.8rem, 1.5vw, 1.1rem);
    font-weight: 900;
    color: #c8ff00;
    letter-spacing: 3px;
    text-align: center;
    margin-bottom: 8px;
    padding: 4px 0;
    border-bottom: 1px solid rgba(200,255,0,0.2);
    flex-shrink: 0;
  }
</style>
</head>
<body>
<header>
  <h1>🫏 DONKEYBALL TOURNAMENT 🫏</h1>
  <div class="subtitle">May the best donkey win</div>
</header>
<div class="champion-banner" id="championBanner">
  <div class="champion-label">🏆 Tournament Champion 🏆</div>
  <div class="champion-name" id="championName"></div>
</div>
<div class="bracket-area" id="bracketArea">
  <div class="no-bracket">
    <div class="big">🫏</div>
    <p>Waiting for bracket...</p>
  </div>
</div>
<footer>
  <span id="refreshDot"></span>
  LIVE — AUTO-REFRESHES EVERY 3 SECONDS — <span id="lastUpdate">--</span>
</footer>
<script>
let lastStateStr = '';

async function loadAndRender() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();
    const str = JSON.stringify(state);
    if (str !== lastStateStr) {
      lastStateStr = str;
      render(state);
    }
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('lastUpdate').textContent = 'Connection error';
  }
}

function getTeamDisplay(id, teams, players) {
  if (!id) return null;
  if (id === 'BYE') return 'BYE';
  const t = teams.find(t => t.id === id);
  if (!t) return '???';
  return t.players.map(pid => { const p = players.find(pl => pl.id === pid); return p ? p.name : null; }).filter(Boolean).join(' & ') || t.name || '???';
}

function render(state) {
  const area = document.getElementById('bracketArea');
  const banner = document.getElementById('championBanner');
  const championEl = document.getElementById('championName');
  const teams = state.teams;
  const players = state.players;

  if (!state.bracket || (!state.bracket.table1 && !state.bracket.table2)) {
    area.innerHTML = '<div class="no-bracket"><div class="big">🫏</div><p>Waiting for bracket...</p></div>';
    banner.classList.remove('show');
    return;
  }

  // Find overall champions
  const champions = [];
  for (const key of ['table1', 'table2']) {
    const b = state.bracket[key];
    if (!b || !b.rounds.length) continue;
    const fm = b.rounds[b.rounds.length - 1][0];
    if (fm && fm.winnerId && fm.winnerId !== 'BYE') {
      champions.push(getTeamDisplay(fm.winnerId, teams, players));
    }
  }
  if (champions.length > 0) {
    banner.classList.add('show');
    championEl.textContent = '🏆 ' + champions.join(' & ') + ' 🏆';
  } else {
    banner.classList.remove('show');
  }

  function renderTable(bracket, tableLabel) {
    if (!bracket) return '';
    const rounds = bracket.rounds;
    const roundLabels = rounds.map((_, i) => {
      if (i === rounds.length - 1) return 'FINALS';
      if (i === rounds.length - 2 && rounds.length > 2) return 'SEMIS';
      return 'ROUND ' + (i + 1);
    });
    return '<div class="table-section">' +
      '<div class="table-label">' + tableLabel + '</div>' +
      rounds.map((round, ri) => {
        const matchesHtml = round.map(match => {
          const t1 = getTeamDisplay(match.team1Id, teams, players);
          const t2 = getTeamDisplay(match.team2Id, teams, players);
          const isBye = match.status === 'bye';
          const isCompleted = match.status === 'completed';
          const isActive = !match.winnerId && !isBye && match.team1Id && match.team2Id && match.team1Id !== 'BYE' && match.team2Id !== 'BYE';

          let boxClass = 'match-box';
          if (isBye) boxClass += ' bye';
          else if (isCompleted || match.winnerId) boxClass += ' completed';
          else if (isActive) boxClass += ' active';

          let statusClass, statusText;
          if (isBye) { statusClass = 'status-bye'; statusText = 'BYE'; }
          else if (match.winnerId) { statusClass = 'status-completed'; statusText = 'FINAL'; }
          else if (isActive) { statusClass = 'status-active'; statusText = 'UP NEXT'; }
          else { statusClass = 'status-pending'; statusText = 'PENDING'; }

          function teamRowHtml(teamId, teamName) {
            if (!teamId || !teamName) {
              return '<div class="team-row tbd"><span class="team-name">TBD</span></div>';
            }
            if (teamId === 'BYE') return '<div class="team-row bye-team"><span class="team-name">BYE</span></div>';
            const isWinner = match.winnerId === teamId;
            const isLoser = match.winnerId && match.winnerId !== teamId && match.winnerId !== 'BYE';
            let cls = 'team-row';
            if (isWinner) cls += ' winner';
            else if (isLoser) cls += ' loser';
            return '<div class="' + cls + '">' +
              (isWinner ? '<span class="trophy">🏆</span>' : '') +
              '<span class="team-name">' + teamName + '</span>' +
              '</div>';
          }

          return '<div class="' + boxClass + '">' +
            '<span class="match-status-badge ' + statusClass + '">' + statusText + '</span>' +
            teamRowHtml(match.team1Id, t1) +
            '<div class="vs-divider">VS</div>' +
            teamRowHtml(match.team2Id, t2) +
            '<div class="connector"></div>' +
            '</div>';
        }).join('');
        return '<div class="round-col"><div class="round-label">' + roundLabels[ri] + '</div>' + matchesHtml + '</div>';
      }).join('') +
      '</div>';
  }

  area.innerHTML = '<div class="dual-bracket">' +
    renderTable(state.bracket.table1, '🏓 TABLE 1') +
    (state.bracket.table2 ? renderTable(state.bracket.table2, '🏓 TABLE 2') : '') +
    '</div>';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadAndRender();
setInterval(loadAndRender, 3000);
</script>
</body>
</html>`;
}

// ─── Request body parser ───────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  // ── HTML pages ──
  if (method === 'GET' && (pathname === '/' || pathname === '/signup')) {
    const data = await loadData();
    const q = parsed.query;
    return sendHTML(res, signupPage(data, q.status, q.name));
  }
  if (pathname === '/admin') {
    return sendHTML(res, adminPage());
  }
  if (pathname === '/tv' || pathname === '/bracket') {
    return sendHTML(res, tvPage());
  }

  // POST /signup (server-side form submission)
  if (method === 'POST' && pathname === '/signup') {
    const body = await parseFormBody(req);
    const name = (body.name || '').trim();
    if (!name) return redirect(res, '/signup?status=empty');
    if (name.length > 50) return redirect(res, '/signup?status=empty');
    const data = await loadData();
    const dup = data.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (dup) return redirect(res, '/signup?status=dup');
    const player = { id: uuid(), name, createdAt: new Date().toISOString() };
    data.players.push(player);
    await saveData(data);
    console.log(`  -> Player signed up: ${name}`);
    return redirect(res, '/signup?status=ok&name=' + encodeURIComponent(name));
  }

  // ── API ──

  // GET /api/state
  if (method === 'GET' && pathname === '/api/state') {
    return sendJSON(res, 200, await loadData());
  }

  // GET /api/players
  if (method === 'GET' && pathname === '/api/players') {
    const data = await loadData();
    return sendJSON(res, 200, data.players);
  }

  // POST /api/signup
  if (method === 'POST' && pathname === '/api/signup') {
    const body = await parseBody(req);
    const name = (body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Name is required' });
    if (name.length > 50) return sendJSON(res, 400, { error: 'Name too long' });
    const data = await loadData();
    const dup = data.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (dup) return sendJSON(res, 409, { error: 'That name is already registered!' });
    const player = { id: uuid(), name, createdAt: new Date().toISOString() };
    data.players.push(player);
    await saveData(data);
    console.log(`  -> Player signed up: ${name}`);
    return sendJSON(res, 201, { player, playerCount: data.players.length });
  }

  // POST /api/players (admin add)
  if (method === 'POST' && pathname === '/api/players') {
    const body = await parseBody(req);
    const name = (body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Name is required' });
    if (name.length > 50) return sendJSON(res, 400, { error: 'Name too long' });
    const data = await loadData();
    const dup = data.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (dup) return sendJSON(res, 409, { error: 'Player already exists' });
    const player = { id: uuid(), name, createdAt: new Date().toISOString() };
    data.players.push(player);
    await saveData(data);
    console.log(`  -> Admin added player: ${name}`);
    return sendJSON(res, 201, { player });
  }

  // DELETE /api/players/:id
  const deletePlayerMatch = pathname.match(/^\/api\/players\/([^/]+)$/);
  if (method === 'DELETE' && deletePlayerMatch) {
    const id = deletePlayerMatch[1];
    const data = await loadData();
    const idx = data.players.findIndex(p => p.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Player not found' });
    const [removed] = data.players.splice(idx, 1);
    // Also remove from teams
    data.teams.forEach(t => { t.players = t.players.filter(pid => pid !== id); });
    await saveData(data);
    console.log(`  -> Removed player: ${removed.name}`);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/teams/generate
  if (method === 'POST' && pathname === '/api/teams/generate') {
    const data = await loadData();
    if (data.players.length < 2) return sendJSON(res, 400, { error: 'Need at least 2 players' });
    const shuffled = shuffle([...data.players]);
    const teamSize = 2;
    const numTeams = Math.ceil(shuffled.length / teamSize);
    const names = pickTeamNames(numTeams);
    const teams = [];
    for (let i = 0; i < numTeams; i++) {
      const start = i * teamSize;
      const end = Math.min(start + teamSize, shuffled.length);
      // Distribute remainder evenly - last team gets extras
      teams.push({
        id: uuid(),
        name: names[i],
        players: shuffled.slice(start, end).map(p => p.id)
      });
    }
    data.teams = teams;
    data.bracket = null; // reset bracket
    await saveData(data);
    console.log(`  -> Generated ${teams.length} teams`);
    return sendJSON(res, 200, { teams });
  }

  // PUT /api/teams/:id
  const putTeamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (method === 'PUT' && putTeamMatch) {
    const id = putTeamMatch[1];
    const body = await parseBody(req);
    const data = await loadData();
    const team = data.teams.find(t => t.id === id);
    if (!team) return sendJSON(res, 404, { error: 'Team not found' });
    if (body.name !== undefined) team.name = String(body.name).trim() || team.name;
    if (body.players !== undefined) team.players = body.players;
    await saveData(data);
    console.log(`  -> Updated team: ${team.name}`);
    return sendJSON(res, 200, { team });
  }

  // POST /api/teams/swap
  if (method === 'POST' && pathname === '/api/teams/swap') {
    const body = await parseBody(req);
    const { playerId, fromTeamId, toTeamId } = body;
    if (!playerId || !fromTeamId || !toTeamId) return sendJSON(res, 400, { error: 'Missing fields' });
    const data = await loadData();
    const from = data.teams.find(t => t.id === fromTeamId);
    const to = data.teams.find(t => t.id === toTeamId);
    if (!from || !to) return sendJSON(res, 404, { error: 'Team not found' });
    from.players = from.players.filter(pid => pid !== playerId);
    if (!to.players.includes(playerId)) to.players.push(playerId);
    await saveData(data);
    console.log(`  -> Moved player ${playerId} from ${from.name} to ${to.name}`);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/bracket/generate
  if (method === 'POST' && pathname === '/api/bracket/generate') {
    const data = await loadData();
    if (data.teams.length < 2) return sendJSON(res, 400, { error: 'Need at least 2 teams' });
    const shuffled = shuffle([...data.teams]);
    const mid = Math.ceil(shuffled.length / 2);
    const table1Teams = shuffled.slice(0, mid);
    const table2Teams = shuffled.slice(mid);
    const bracket = {
      table1: generateBracket(table1Teams),
      table2: table2Teams.length >= 2 ? generateBracket(table2Teams) : null
    };
    data.bracket = bracket;
    await saveData(data);
    console.log(`  -> Generated dual bracket: Table 1 (${table1Teams.length} teams), Table 2 (${table2Teams.length} teams)`);
    return sendJSON(res, 200, { bracket });
  }

  // PUT /api/bracket/match/:matchId
  const putMatchMatch = pathname.match(/^\/api\/bracket\/match\/([^/]+)$/);
  if (method === 'PUT' && putMatchMatch) {
    const matchId = putMatchMatch[1];
    const body = await parseBody(req);
    const { winnerId } = body;
    if (!winnerId) return sendJSON(res, 400, { error: 'winnerId required' });
    const data = await loadData();
    if (!data.bracket) return sendJSON(res, 404, { error: 'No bracket' });

    let found = false;
    let foundTable = null;
    for (const tableKey of ['table1', 'table2']) {
      const tableBracket = data.bracket[tableKey];
      if (!tableBracket) continue;
      for (const round of tableBracket.rounds) {
        for (const match of round) {
          if (match.id === matchId) {
            if (winnerId !== match.team1Id && winnerId !== match.team2Id) {
              return sendJSON(res, 400, { error: 'Invalid winner' });
            }
            match.winnerId = winnerId;
            match.status = 'completed';
            found = true;
            foundTable = tableKey;
            break;
          }
        }
        if (found) break;
      }
      if (found) break;
    }

    if (!found) return sendJSON(res, 404, { error: 'Match not found' });

    propagateBracket(data.bracket[foundTable]);
    await saveData(data);
    console.log(`  -> Match ${matchId} winner set: ${winnerId}`);
    return sendJSON(res, 200, { bracket: data.bracket });
  }

  // GET /api/debug
  if (method === 'GET' && pathname === '/api/debug') {
    const upstashConfigured = !!(UPSTASH_URL && UPSTASH_TOKEN);
    let upstashOk = false;
    let upstashError = null;
    let data = null;
    if (upstashConfigured) {
      try {
        const r = await fetch(UPSTASH_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(['PING'])
        });
        const j = await r.json();
        upstashOk = j.result === 'PONG';
        if (!upstashOk) upstashError = JSON.stringify(j);
      } catch (e) {
        upstashError = e.message;
      }
    }
    if (upstashOk) data = await loadData();
    return sendJSON(res, 200, {
      upstashConfigured,
      upstashOk,
      upstashError,
      urlPrefix: UPSTASH_URL ? UPSTASH_URL.slice(0, 30) + '...' : null,
      playerCount: data ? data.players.length : null,
      useUpstash: USE_UPSTASH
    });
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    console.error('[error]', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🫏  DONKEYBALL TOURNAMENT SERVER  🫏');
  console.log('  ─────────────────────────────────────');
  console.log(`  Signup Page   →  http://localhost:${PORT}/signup`);
  console.log(`  Admin Panel   →  http://localhost:${PORT}/admin`);
  console.log(`  TV Display    →  http://localhost:${PORT}/tv`);
  console.log('  ─────────────────────────────────────');
  console.log(`  Data file     →  ${DATA_FILE}`);
  console.log('');
});
