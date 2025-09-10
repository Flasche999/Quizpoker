// server.js – QuizPoker (ESM)
// Flow:
//  - Frage starten -> Runde 1 (Aktionen). In R1 dürfen SB/BB NICHT folden.
//  - Wenn Runde 1 komplett -> Admin kann Hinweis 1 aufdecken -> Runde 2.
//  - Wenn Runde 2 komplett -> Admin kann Hinweis 2 aufdecken -> Runde 3.
//  - Wenn Runde 3 komplett -> Admin kann Lösung aufdecken -> Runde 4 (finale Aktionen + Schätzwerte).
//  - Pot an Gewinner (manuell oder auto-nächstliegend bei target).
//
// Neu:
// - Turn-Logik mit "pending"-Set: Raise öffnet Action erneut für alle, die noch nicht auf das neue Bet-Level equalized sind.
// - Striktes Rundenende: pending leer ODER ≤1 aktive Spieler.
// - Admin-Controls: set-turn / next-turn / skip-fold.
// - Sofort-Schätzantworten ab Runde 1 (nicht mehr nur Runde 4).
// - Private DMs Spieler ↔ Admin mit Löschfunktionen.
// - Chips-Massen-/Einzelverteilung (set-all / add-all / add-one).

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 60000,
  connectionStateRecovery: {}
});

// ─────────────────────────────────────────────────────────────
// Static & Helpers
// ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, _res, next) => { console.log('[REQ]', req.method, req.url); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.status(200).type('text').send('OK'));
app.get('/', (_req, res) => {
  const file = path.join(__dirname, 'public', 'admin.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(200).type('text').send('Lade /public/admin.html hoch oder rufe /player.html auf.');
});

// Fragen laden
function loadQuestions() {
  const p = path.join(__dirname, 'public', 'fragen.json');
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.error('fragen.json laden fehlgeschlagen:', e.message); }
  return [];
}

// ─────────────────────────────────────────────────────────────
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
const MAX_SEATS = 8;

const rooms = new Map();
/*
  room = {
    code, moderatorId, version,
    players: Map<uid,{
      uid,name,seat,connected,socketId,
      chips,status,           // 'active' | 'folded' | 'allin'
      betTotal, betRound,
      estimate                // number|null|undefined
    }>,
    questions, qIndex,
    pot,
    blinds: { small:number|null, big:number|null },
    // Round engine:
    roundIndex,                   // 0 = keine, 1..4 = aktive Runde
    currentBetRound,              // gefordertes Bet-Level dieser Runde
    pending: Set<uid>,            // wer muss noch reagieren (diese Runde)
    turnUid: string|null,         // am Zug
    reveals: { hint1:boolean, hint2:boolean, solution:boolean },
    chats: Map<uid, Array<{from:'player'|'admin',message:string,ts:number}>>,
    closeTimer: Timeout|null
  }
*/

const roomState = (room) => {
  const q = room.questions?.[room.qIndex] || null;
  const question = q ? {
    index: room.qIndex,
    text: q.text || '',
    hint1: room.reveals?.hint1 ? (q.hint1 || '') : null,
    hint2: room.reveals?.hint2 ? (q.hint2 || '') : null,
    solution: room.reveals?.solution ? (q.solution || '') : null,
    hasHint1: !!q.hint1, hasHint2: !!q.hint2, hasSolution: !!q.solution
  } : null;

  return {
    code: room.code,
    version: room.version || 0,
    pot: room.pot || 0,
    qIndex: room.qIndex ?? -1,
    blinds: room.blinds || { small: null, big: null },
    turnUid: room.turnUid || null,
    roundIndex: room.roundIndex || 0,
    currentBetRound: room.currentBetRound || 0,
    actedCount: countActionablePlayers(room) - (room.pending?.size || 0),
    needCount: countActionablePlayers(room),
    reveals: room.reveals || { hint1:false, hint2:false, solution:false },
    players: Array.from(room.players.values()).map(p => ({
      uid: p.uid, name: p.name, seat: p.seat ?? null, connected: !!p.connected,
      chips: p.chips ?? 0, status: p.status || 'active',
      betTotal: p.betTotal || 0, betRound: p.betRound || 0,
      estimate: (p.estimate === null || typeof p.estimate === 'number') ? p.estimate : null
    })),
    question
  };
};

const bump = (room) => { room.version = (room.version || 0) + 1; };
const ensureRoom = (code) => rooms.get(code) || null;

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────
function seatIsFree(room, idx) { for (const p of room.players.values()) if (p.seat === idx) return false; return true; }
function nextFreeSeat(room) { for (let i = 0; i < MAX_SEATS; i++) if (seatIsFree(room, i)) return i; return -1; }

function listSeats(room, filterFn) {
  return Array.from(room.players.values())
    .filter(p => Number.isInteger(p.seat) && (!filterFn || filterFn(p)))
    .sort((a,b)=>a.seat-b.seat);
}
function countActivePlayers(room) { // nicht gefoldet
  let n=0; for (const p of room.players.values()) if (p.status !== 'folded') n++; return n;
}
function countActionablePlayers(room) { // nur 'active', nicht allin/folded
  let n=0; for (const p of room.players.values()) if (p.status === 'active') n++; return n;
}
const isActionable = (p) => p.status === 'active';
const isBlindSeat = (room, p) =>
  (Number.isInteger(room.blinds?.small) && p.seat === room.blinds.small) ||
  (Number.isInteger(room.blinds?.big)   && p.seat === room.blinds.big);

function startSeatUid(room) {
  const seatList = listSeats(room, isActionable);
  if (seatList.length === 0) return null;
  if (Number.isInteger(room.blinds?.big)) {
    const bb = room.blinds.big;
    const after = seatList.filter(p=>p.seat>bb);
    return (after[0] || seatList[0]).uid;
  }
  return seatList[0].uid;
}

function resetAllBets(room) {
  room.pot = room.pot || 0;
  room.currentBetRound = 0;
  for (const p of room.players.values()) {
    p.betTotal = 0; p.betRound = 0; p.status = 'active'; p.estimate = undefined;
  }
}

function resetRound(room) {
  room.currentBetRound = 0;
  room.pending = new Set(Array.from(room.players.values()).filter(isActionable).map(p=>p.uid));
  for (const p of room.players.values()) { p.betRound = 0; }
  room.turnUid = startSeatUid(room);
}

function addToPot(room, p, amount) {
  const amt = Math.max(0, Math.min(Number(amount)||0, p.chips));
  if (!amt) return 0;
  p.chips -= amt;
  p.betRound = (p.betRound || 0) + amt;
  p.betTotal = (p.betTotal || 0) + amt;
  room.pot = (room.pot || 0) + amt;
  return amt;
}

function canFold(room, p) {
  if (room.roundIndex === 1 && isBlindSeat(room, p)) return false; // SB/BB Schutz in Runde 1
  return true;
}

function nextFromPending(room, afterSeat) {
  if (!room.pending || room.pending.size === 0) return null;
  const cand = listSeats(room, q => room.pending.has(q.uid) && isActionable(q));
  if (cand.length === 0) return null;
  const after = cand.filter(p=>p.seat > afterSeat);
  return (after[0] || cand[0]).uid;
}

function advanceAfter(room, uidJustActed) {
  const p = room.players.get(uidJustActed);
  const seat = (p && Number.isInteger(p.seat)) ? p.seat : -1;
  const next = nextFromPending(room, seat);
  room.turnUid = next || null;
}

function roundIsComplete(room) {
  // Ende, wenn niemand mehr reagieren muss ODER ≤1 aktive Spieler übrig
  if (!room.pending || room.pending.size === 0) return true;
  if (countActionablePlayers(room) <= 1) return true;
  return false;
}

function broadcastFull(room, code) { bump(room); io.in(code).emit('state:full', roomState(room)); }
function broadcastPartial(room, code, patch={}) { bump(room); io.in(code).emit('state:partial', { version: room.version, ...patch }); }

// ─────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  // Admin erstellt Raum
  socket.on('mod:create-room', () => {
    let code; do { code = genCode(); } while (rooms.has(code));
    const room = {
      code, moderatorId: socket.id, version: 0,
      players: new Map(), questions: loadQuestions(), qIndex: -1,
      pot: 0, blinds: { small:null, big:null },
      roundIndex: 0, currentBetRound: 0,
      pending: new Set(), turnUid: null,
      reveals: { hint1:false, hint2:false, solution:false },
      chats: new Map(),
      closeTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data = { role:'moderator', room:code };
    io.to(socket.id).emit('mod:room-created', { code, state: roomState(room) });
    console.log('[ROOM] created', code);
  });

  // Moderator erneut übernehmen
  socket.on('mod:claim-room', ({ code }) => {
    code = String(code||'').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { io.to(socket.id).emit('status','Raum nicht gefunden.'); return; }
    room.moderatorId = socket.id;
    if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer=null; }
    socket.join(code);
    socket.data = { role:'moderator', room:code };
    io.to(socket.id).emit('state:full', roomState(room));
    io.in(code).emit('status','Moderator ist wieder da.');
  });

  // Admin: Blinds setzen (Seat-Index 0..7 oder null)
  socket.on('mod:set-blinds', ({ small, big }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    room.blinds = {
      small: Number.isInteger(small) ? small : null,
      big:   Number.isInteger(big)   ? big   : null
    };
    broadcastPartial(room, c, { blinds: room.blinds });
  });

  // Admin: Frage starten -> Runde 1 (Sofort-Schätzen ab hier erlaubt)
  socket.on('mod:next-question', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (!room.questions || room.questions.length===0) return;

    if (room.qIndex + 1 < room.questions.length) {
      room.qIndex += 1;
      room.reveals = { hint1:false, hint2:false, solution:false };
      resetAllBets(room);           // setzt auch estimate=undefined
      room.roundIndex = 1;
      resetRound(room);
      broadcastFull(room, c);
      io.in(c).emit('status','Runde 1 gestartet. (SB/BB dürfen in R1 nicht folden) – Schätzwerte können ab jetzt gesendet werden.');
    } else {
      io.in(c).emit('status','🎉 Alle Fragen durch!');
    }
  });

  // Admin: Turn setzen / Nächster / Skip-Fold
  socket.on('mod:set-turn', ({ uid, seat }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    let targetUid = null;
    if (uid && room.players.has(uid)) targetUid = uid;
    else if (Number.isInteger(seat)) {
      const p = Array.from(room.players.values()).find(x => x.seat === seat);
      if (p) targetUid = p.uid;
    }
    if (!targetUid) { io.to(socket.id).emit('status','Turn-Ziel nicht gefunden.'); return; }
    if (room.pending && !room.pending.has(targetUid)) room.pending.add(targetUid);
    room.turnUid = targetUid;
    broadcastPartial(room, c, {
      turnUid: room.turnUid,
      actedCount: countActionablePlayers(room) - (room.pending?.size || 0),
      needCount: countActionablePlayers(room)
    });
  });

  socket.on('mod:next-turn', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const cur = room.players.get(room.turnUid || '') || null;
    const seat = (cur && Number.isInteger(cur.seat)) ? cur.seat : -1;
    const next = nextFromPending(room, seat);
    room.turnUid = next || null;
    broadcastPartial(room, c, { turnUid: room.turnUid });
  });

  socket.on('mod:skip-fold', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const uid = room.turnUid; if (!uid) return;
    const p = room.players.get(uid); if (!p) return;
    p.status = 'folded';
    if (room.pending) room.pending.delete(uid);
    if (roundIsComplete(room)) {
      room.turnUid = null;
      io.in(c).emit('status', `Runde ${room.roundIndex} komplett.`);
    } else {
      advanceAfter(room, uid);
    }
    broadcastPartial(room, c, {
      turnUid: room.turnUid,
      actedCount: countActionablePlayers(room) - (room.pending?.size || 0),
      needCount: countActionablePlayers(room)
    });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });

  // Admin: Reveal-Buttons beachten striktes Rundenende
  socket.on('mod:reveal-hint1', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (room.roundIndex !== 1 || !roundIsComplete(room)) { io.to(socket.id).emit('status','Runde 1 noch nicht komplett.'); return; }
    room.reveals.hint1 = true;
    broadcastPartial(room, c, { reveals: room.reveals, question: roomState(room).question });
    room.roundIndex = 2; resetRound(room);
    broadcastPartial(room, c, {
      roundIndex: room.roundIndex, turnUid: room.turnUid,
      actedCount: 0, needCount: countActionablePlayers(room),
      currentBetRound: room.currentBetRound
    });
    io.in(c).emit('status','Hinweis 1 aufgedeckt. Runde 2 gestartet.');
  });

  socket.on('mod:reveal-hint2', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (room.roundIndex !== 2 || !roundIsComplete(room)) { io.to(socket.id).emit('status','Runde 2 noch nicht komplett.'); return; }
    room.reveals.hint2 = true;
    broadcastPartial(room, c, { reveals: room.reveals, question: roomState(room).question });
    room.roundIndex = 3; resetRound(room);
    broadcastPartial(room, c, {
      roundIndex: room.roundIndex, turnUid: room.turnUid,
      actedCount: 0, needCount: countActionablePlayers(room),
      currentBetRound: room.currentBetRound
    });
    io.in(c).emit('status','Hinweis 2 aufgedeckt. Runde 3 gestartet.');
  });

  socket.on('mod:reveal-solution', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (room.roundIndex !== 3 || !roundIsComplete(room)) { io.to(socket.id).emit('status','Runde 3 noch nicht komplett.'); return; }
    room.reveals.solution = true;
    broadcastPartial(room, c, { reveals: room.reveals, question: roomState(room).question });
    room.roundIndex = 4; resetRound(room);
    broadcastPartial(room, c, {
      roundIndex: room.roundIndex, turnUid: room.turnUid,
      actedCount: 0, needCount: countActionablePlayers(room),
      currentBetRound: room.currentBetRound
    });
    io.in(c).emit('status','Lösung aufgedeckt. Runde 4 (final) gestartet – jetzt letzte Aktion! (Schätzwerte konntet ihr bereits ab Runde 1 abgeben.)');
  });

  // Admin: Pot-Award
  socket.on('mod:award-pot', ({ uid }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid);
    if (!p) { io.to(socket.id).emit('status','Gewinner nicht gefunden.'); return; }
    const pot = room.pot || 0;
    if (pot > 0) { p.chips = (p.chips||0) + pot; room.pot = 0; }
    for (const pl of room.players.values()) { pl.betRound = 0; }
    room.currentBetRound = 0;
    broadcastPartial(room, c, { pot: room.pot, currentBetRound: room.currentBetRound });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit('status', `🏆 Pot (${pot}) geht an ${p.name}.`);
  });

  socket.on('mod:award-nearest', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const q = room.questions?.[room.qIndex]; if (!q || typeof q.target !== 'number') { io.to(socket.id).emit('status','Kein Zielwert (target) in Frage.'); return; }
    const cand = Array.from(room.players.values()).filter(p => p.status!=='folded' && typeof p.estimate === 'number');
    if (cand.length === 0) { io.to(socket.id).emit('status','Keine gültigen Schätzwerte vorhanden.'); return; }
    cand.sort((a,b)=> Math.abs(a.estimate - q.target) - Math.abs(b.estimate - q.target));
    const winner = cand[0];
    const pot = room.pot || 0;
    if (pot>0) { winner.chips = (winner.chips||0) + pot; room.pot = 0; }
    for (const pl of room.players.values()) { pl.betRound = 0; }
    room.currentBetRound = 0;
    broadcastPartial(room, c, { pot: room.pot, currentBetRound: room.currentBetRound });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit('status', `🏆 Pot (${pot}) automatisch an ${winner.name} (Ziel ${q.target}).`);
  });

  // Admin: bestehende Chips-Controls (behalten)
  socket.on('mod:mark', ({ uid, result, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const d = Number(delta); if (Number.isFinite(d) && d !== 0) p.chips = Math.max(0, (p.chips || 0) + d);
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit(result === 'correct' ? 'result:correct' : 'result:wrong', { uid, name: p.name, delta: d||0 });
  });
  socket.on('mod:adjust', ({ uid, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const d = Number(delta); if (!Number.isFinite(d) || d === 0) return;
    p.chips = Math.max(0, (p.chips || 0) + d);
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });
  socket.on('mod:sync-all', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    io.in(c).emit('state:full', roomState(room));
  });

  // ─────────── NEU: Chips-Distribution (Admin-Panel) ───────────
  socket.on('mod:chips-set-all', ({ amount }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const val = Math.max(0, Number(amount) || 0);
    for (const p of room.players.values()) p.chips = val;
    broadcastPartial(room, c, { pot: room.pot });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit('status', `Startchips gesetzt: ${val} für alle Spieler.`);
  });
  socket.on('mod:chips-add-all', ({ delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const d = Number(delta) || 0;
    for (const p of room.players.values()) p.chips = Math.max(0, (p.chips||0) + d);
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit('status', `Allen ${d>=0?'+':''}${d} Chips hinzugefügt.`);
  });
  socket.on('mod:chips-add-one', ({ uid, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const d = Number(delta) || 0;
    p.chips = Math.max(0, (p.chips||0) + d);
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit('status', `${p.name} ${d>=0?'+':''}${d} Chips.`);
  });

  // Spieler: Reconnect/Backfill
  socket.on('hello', ({ uid, room: code }) => {
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    const p = room.players.get(uid);
    if (!p) { io.to(socket.id).emit('state:full', roomState(room)); return; }
    p.connected = true; p.socketId = socket.id;
    socket.join(code);
    socket.data = { role:'player', room:code, uid };
    io.to(socket.id).emit('state:full', roomState(room));
    io.in(code).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });

  // Spieler: Join
  socket.on('player:join', ({ code, uid, name }) => {
    code = String(code||'').toUpperCase().trim();
    if (!rooms.has(code)) { io.to(socket.id).emit('player:join-result', { ok:false, error:'Raum nicht gefunden.' }); return; }
    const room = rooms.get(code);

    let existing = room.players.get(uid);
    if (existing && existing.connected) {
      const oldSockId = existing.socketId;
      const oldSock = oldSockId && io.sockets.sockets.get(oldSockId);
      if (oldSock) { io.to(oldSockId).emit('status','Du wurdest durch eine neue Verbindung abgelöst.'); try { oldSock.disconnect(true); } catch {} }
    }
    const desiredName = String(name||'Spieler').slice(0,24);
    if (Array.from(room.players.values()).some(p => p.uid!==uid && (p.name||'').trim().toLowerCase()===desiredName.trim().toLowerCase())) {
      io.to(socket.id).emit('player:join-result', { ok:false, error:'Dieser Name ist bereits vergeben.' }); return;
    }

    let p = existing;
    if (!p) {
      const seat = nextFreeSeat(room);
      if (seat === -1) { io.to(socket.id).emit('player:join-result', { ok:false, error:'Tisch ist voll (8/8).' }); return; }
      p = { uid, name: desiredName, seat, connected:true, socketId: socket.id, chips:100,
            status:'active', betTotal:0, betRound:0, estimate: undefined };
      room.players.set(uid, p);
      if (room.roundIndex>0 && room.pending && isActionable(p)) room.pending.add(uid);
      if (!room.turnUid && room.roundIndex>0) room.turnUid = startSeatUid(room);
    } else {
      p.connected = true; p.socketId = socket.id; p.name = desiredName;
    }

    socket.join(code);
    socket.data = { role:'player', room:code, uid };

    io.to(socket.id).emit('player:join-result', { ok:true, code, uid:p.uid, name:p.name, chips:p.chips, seat:p.seat });
    io.to(socket.id).emit('state:full', roomState(room));
    io.in(code).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });

  // ─────────── Private DMs (NEU) ───────────
  // Spieler → Admin
  socket.on('player:dm', ({ message }) => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const msg = String(message ?? '').slice(0, 2000);
    const entry = { from:'player', message: msg, ts: Date.now() };
    const arr = room.chats.get(uid) ?? [];
    arr.push(entry); room.chats.set(uid, arr);
    if (room.moderatorId) io.to(room.moderatorId).emit('dm:from-player', { uid, name: p.name, message: msg, ts: entry.ts });
  });

  // Admin → Spieler
  socket.on('mod:dm', ({ uid, message }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const msg = String(message ?? '').slice(0, 2000);
    const entry = { from:'admin', message: msg, ts: Date.now() };
    const arr = room.chats.get(uid) ?? [];
    arr.push(entry); room.chats.set(uid, arr);
    io.to(p.socketId || '').emit('dm:from-admin', { message: msg, ts: entry.ts });
    if (room.moderatorId) io.to(room.moderatorId).emit('dm:sent', { uid, name: p.name, message: msg, ts: entry.ts });
  });

  // Chats löschen
  socket.on('mod:chat-clear-one', ({ uid }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    room.chats.set(uid, []);
    const p = room.players.get(uid);
    if (p?.socketId) io.to(p.socketId).emit('dm:cleared');
    if (room.moderatorId) io.to(room.moderatorId).emit('dm:cleared-one', { uid });
  });
  socket.on('mod:chat-clear-all', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    room.chats.clear();
    // Info an alle Spieler
    for (const p of room.players.values()) if (p.socketId) io.to(p.socketId).emit('dm:cleared');
    if (room.moderatorId) io.to(room.moderatorId).emit('dm:cleared-all');
  });

  // Spieler: Nachricht an Admin (bestehende einfache Textantwort; optional)
  socket.on('player:answer', ({ answer }) => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    if (room.moderatorId) io.to(room.moderatorId).emit('answer:received', { uid:p.uid, name:p.name, answer: String(answer||'') });
  });

  // ─────────── Schätzantwort (NEU: ab Runde 1 erlaubt) ───────────
  socket.on('player:estimate', ({ value }) => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    // ab Runde 1 (sobald Frage gestartet wurde) erlaubt:
    if (room.roundIndex < 1 || room.qIndex < 0) { io.to(socket.id).emit('status','Noch keine aktive Frage.'); return; }
    const v = (value===null || value===undefined) ? null : Number(value);
    if (v===null || Number.isFinite(v)) {
      p.estimate = v; // ein Update überschreibt die vorherige Eingabe; falls "nur einmal" gewünscht, hier absichern.
      if (room.moderatorId) io.to(room.moderatorId).emit('status', `📩 Schätzantwort von ${p.name}: ${v===null?'(leer)':v}`);
      io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    }
  });

  // ─────────── Aktionen mit pending/Turn ───────────
  function ensureTurn(socket, room) {
    const uid = socket.data?.uid;
    return !!uid && uid === room.turnUid;
  }
  function afterAction(room, uidActed, code) {
    // Ende prüfen
    if (roundIsComplete(room)) {
      room.turnUid = null;
      broadcastPartial(room, code, {
        turnUid: room.turnUid,
        actedCount: countActionablePlayers(room) - (room.pending?.size || 0),
        needCount: countActionablePlayers(room),
        currentBetRound: room.currentBetRound,
        pot: room.pot
      });
      io.in(code).emit('status', `Runde ${room.roundIndex} komplett.`);
    } else {
      advanceAfter(room, uidActed);
      broadcastPartial(room, code, {
        turnUid: room.turnUid,
        actedCount: countActionablePlayers(room) - (room.pending?.size || 0),
        needCount: countActionablePlayers(room),
        currentBetRound: room.currentBetRound,
        pot: room.pot
      });
    }
    io.in(code).emit('players:update', { version: ++room.version, players: roomState(room).players });
  }

  socket.on('player:bet', ({ amount }) => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!ensureTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p || p.status!=='active') return;

    const add = Math.max(1, parseInt(amount||'0',10)||0);
    const prev = room.currentBetRound || 0;
    const added = addToPot(room, p, add);
    if (!added) return;

    // Raise?
    if (p.betRound > room.currentBetRound) room.currentBetRound = p.betRound;
    // Spieler hat gehandelt -> aus pending raus
    if (room.pending) room.pending.delete(uid);

    // Wenn Raise (neues Level), müssen alle aktiven (≠folded/≠allin) mit weniger betRound wieder in pending (außer Raiser)
    const raised = room.currentBetRound > prev;
    if (raised) {
      for (const q of room.players.values()) {
        if (q.uid === uid) continue;
        if (isActionable(q) && (q.betRound || 0) < room.currentBetRound) room.pending.add(q.uid);
      }
    }

    afterAction(room, uid, c);
  });

  socket.on('player:call', () => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!ensureTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p || p.status!=='active') return;

    const need = Math.max(0, (room.currentBetRound||0) - (p.betRound||0));
    if (need > 0) addToPot(room, p, need);
    if (room.pending) room.pending.delete(uid);

    afterAction(room, uid, c);
  });

  socket.on('player:allin', () => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!ensureTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p || p.status!=='active') return;

    const prev = room.currentBetRound || 0;
    addToPot(room, p, p.chips);
    p.status = 'allin';
    if (p.betRound > room.currentBetRound) room.currentBetRound = p.betRound;

    if (room.pending) room.pending.delete(uid);

    // All-in kann Raise sein -> pending reaktivieren
    const raised = room.currentBetRound > prev;
    if (raised) {
      for (const q of room.players.values()) {
        if (q.uid === uid) continue;
        if (isActionable(q) && (q.betRound || 0) < room.currentBetRound) room.pending.add(q.uid);
      }
    }

    afterAction(room, uid, c);
  });

  socket.on('player:fold', () => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!ensureTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p) return;
    if (!canFold(room, p)) { io.to(socket.id).emit('status','SB/BB dürfen in Runde 1 nicht folden.'); return; }

    p.status = 'folded';
    if (room.pending) room.pending.delete(uid);

    afterAction(room, uid, c);
  });

  // Disconnect Handling
  socket.on('disconnect', (reason) => {
    const c = socket.data?.room;
    if (!c || !rooms.has(c)) return;
    const room = rooms.get(c);
    const role = socket.data?.role;

    if (role === 'moderator') {
      room.moderatorId = null;
      io.in(c).emit('status','Moderator kurz weg – Raum bleibt bestehen.');
      if (room.closeTimer) clearTimeout(room.closeTimer);
      room.closeTimer = setTimeout(() => {
        if (!room.moderatorId) {
          io.in(c).emit('status','Raum wurde beendet (Moderator nicht zurückgekehrt).');
          io.in(c).socketsLeave(c);
          rooms.delete(c);
        }
      }, 5*60*1000);
      return;
    }

    const uid = socket.data?.uid;
    if (uid && room.players.has(uid)) {
      const p = room.players.get(uid);
      if (p.socketId === socket.id) p.socketId = null;
      p.connected = false;
      io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });

      // wenn Spieler am Zug -> nur Turn weitergeben, pending bleibt
      if (room.turnUid === uid) {
        const seat = Number.isInteger(p.seat) ? p.seat : -1;
        const next = nextFromPending(room, seat);
        room.turnUid = next || null;
        broadcastPartial(room, c, { turnUid: room.turnUid });
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('QuizPoker listening on :' + PORT);
  console.log('Static dir:', path.join(__dirname, 'public'));
});
