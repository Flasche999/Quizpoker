// server.js – QuizPoker (ESM)
// Flow jetzt:
//  - Frage starten -> Runde 1 (Aktionen). In R1 dürfen alle folden, AUSSER SB/BB.
//  - Wenn alle in R1 eine Aktion gemacht haben -> Admin darf Hint 1 aufdecken -> Runde 2 (Aktionen, auch SB/BB dürfen jetzt folden).
//  - Wenn alle in R2 eine Aktion gemacht haben -> Admin darf Hint 2 aufdecken -> Runde 3 (Aktionen).
//  - Wenn alle in R3 eine Aktion gemacht haben -> Admin darf Lösung aufdecken -> Runde 4 (finale Aktionen + Schätzantworten).
//  - Admin zahlt Pot an Gewinner (frei wählbar oder „nächstliegend“ falls Zielwert vorhanden).
//
// Features:
// - Sitzplätze, eindeutige Namen, Reconnect/Takeover
// - Blinds (small/big) als Seat-Index
// - Turn-Order nach Seat (Start = links vom Big Blind; ohne Blinds = kleinster Seat)
// - Pro Runde: currentBetRound + betRound (pro Spieler) + betTotal (gesamt für diese Frage)
// - Bets fließen in room.pot
// - Action-Gating: nur Spieler am Zug darf bet/call/allin/fold
// - R1: SB/BB dürfen NICHT folden (wenn Blinds gesetzt)
// - R2–R4: alle dürfen folden
// - Verdeckte Hinweise: hint1/hint2/solution erst nach Admin-Click sichtbar

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

// Fragen laden (optional Struktur mit Hints/Solution/Target)
function loadQuestions() {
  const p = path.join(__dirname, 'public', 'fragen.json');
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw);
    // Erwartete optionale Felder pro Frage:
    // { text: string, hint1?: string, hint2?: string, solution?: string, target?: number }
    if (Array.isArray(arr)) return arr;
  } catch (e) { console.error('fragen.json laden fehlgeschlagen:', e.message); }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Game State
// ─────────────────────────────────────────────────────────────
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
const MAX_SEATS = 8;

const rooms = new Map();
/*
  room = {
    code,
    moderatorId,
    version,
    players: Map<uid, {
      uid, name, seat, connected, socketId,
      chips, status,            // 'active' | 'folded' | 'allin'
      betTotal,                 // Summe über alle Runden (für diese Frage)
      betRound,                 // Einsatz in der aktuellen Runde
      estimate                  // Schätzantwort (optional)
    }>,
    questions: [...],
    qIndex,                     // -1 vor Start
    pot,                        // Gesamtpot dieser Frage
    blinds: { small: number|null, big: number|null },
    turnUid: string|null,       // wer ist am Zug
    // Rundensteuerung
    roundIndex,                 // 1..4 (Aktionen), 0 = keine Runde aktiv
    acted: Set<string>,         // UIDs, die in aktueller Runde bereits gehandelt haben
    currentBetRound,            // Ziel-Bet für die aktuelle Runde
    reveals: { hint1:boolean, hint2:boolean, solution:boolean },
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
    actedCount: room.acted ? room.acted.size : 0,
    needCount: countActivePlayers(room),
    currentBetRound: room.currentBetRound || 0,
    reveals: room.reveals || { hint1:false, hint2:false, solution:false },
    players: Array.from(room.players.values()).map(p => ({
      uid: p.uid, name: p.name, seat: p.seat ?? null, connected: !!p.connected,
      chips: p.chips ?? 0, status: p.status || 'active',
      betTotal: p.betTotal || 0, betRound: p.betRound || 0
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
function findUidBySeat(room, seat) { for (const p of room.players.values()) if (p.seat === seat) return p.uid; return null; }
function countActivePlayers(room) { let n=0; for (const p of room.players.values()) if (p.status!=='folded') n++; return n; }
function listSeats(room, filterFn) {
  return Array.from(room.players.values())
    .filter(p => typeof p.seat === 'number' && (!filterFn || filterFn(p)))
    .sort((a,b)=>a.seat-b.seat);
}
function firstSeatAfter(room, seat, filterFn) {
  const seats = listSeats(room, filterFn);
  if (seats.length===0) return null;
  // zyklisch
  const after = seats.filter(p => p.seat > seat);
  return (after[0] || seats[0]).uid;
}
function startSeatUid(room) {
  // Start ist links vom Big Blind, wenn vorhanden; sonst kleinster Seat
  if (Number.isInteger(room.blinds?.big)) {
    const bb = room.blinds.big;
    const uid = firstSeatAfter(room, bb, p => p.status!=='folded');
    if (uid) return uid;
  }
  const first = listSeats(room, p=>p.status!=='folded')[0];
  return first ? first.uid : null;
}
function resetAllBets(room) {
  room.pot = room.pot || 0;
  room.currentBetRound = 0;
  for (const p of room.players.values()) { p.betTotal = 0; p.betRound = 0; p.status = 'active'; p.estimate = undefined; }
}
function resetRound(room) {
  room.currentBetRound = 0;
  room.acted = new Set();
  for (const p of room.players.values()) { p.betRound = 0; if (p.status==='active' || p.status==='allin') {/* keep */} }
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
function isBlindSeat(room, p) {
  const s = p.seat;
  return (Number.isInteger(room.blinds?.small) && s===room.blinds.small) ||
         (Number.isInteger(room.blinds?.big)   && s===room.blinds.big);
}
function canFold(room, p) {
  // In Runde 1 dürfen SB/BB NICHT folden (falls gesetzt)
  if (room.roundIndex === 1 && isBlindSeat(room, p)) return false;
  return true;
}
function nextTurn(room) {
  if (!room.turnUid) return;
  const cur = room.players.get(room.turnUid);
  const startSeat = cur && Number.isInteger(cur.seat) ? cur.seat : -1;
  // Nächster aktiver Spieler, der in dieser Runde noch keine Aktion hatte
  let uid = firstSeatAfter(room, startSeat, pp => pp.status!=='folded' && !room.acted.has(pp.uid));
  if (uid) { room.turnUid = uid; return; }
  // Prüfe, ob es überhaupt noch einen offenen Spieler gibt
  const openExists = Array.from(room.players.values()).some(pp => pp.status!=='folded' && !room.acted.has(pp.uid));
  if (openExists) {
    const firstActive = listSeats(room, pp => pp.status!=='folded' && !room.acted.has(pp.uid))[0];
    room.turnUid = firstActive ? firstActive.uid : null;
  } else {
    // Runde ist fertig
    room.turnUid = null;
  }
}
function requireTurn(socket, room) {
  const uid = socket.data?.uid;
  if (!uid || !room.turnUid) return false;
  return uid === room.turnUid;
}
function broadcastFull(room, code) {
  bump(room);
  io.in(code).emit('state:full', roomState(room));
}
function broadcastPartial(room, code, patch={}) {
  bump(room);
  io.in(code).emit('state:partial', { version: room.version, ...patch });
}
function markActedAndAdvance(room, uid) {
  room.acted.add(uid);
  nextTurn(room);
}

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
      turnUid: null, roundIndex: 0, acted: new Set(),
      currentBetRound: 0,
      reveals: { hint1:false, hint2:false, solution:false },
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

  // Admin: nächste Frage starten -> Runde 1
  socket.on('mod:next-question', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (!room.questions || room.questions.length===0) return;

    if (room.qIndex + 1 < room.questions.length) {
      room.qIndex += 1;
      // Reset Frage-Status
      room.reveals = { hint1:false, hint2:false, solution:false };
      room.pot = 0;
      for (const p of room.players.values()) { p.betTotal=0; p.betRound=0; p.status='active'; p.estimate=undefined; }
      room.roundIndex = 1;
      resetRound(room);
      // Startspieler
      room.turnUid = startSeatUid(room);
      broadcastFull(room, c);
      io.in(c).emit('status','Runde 1 gestartet. (SB/BB dürfen in R1 nicht folden)');
    } else {
      io.in(c).emit('status','🎉 Alle Fragen durch!');
    }
  });

  // Admin: Hinweise/Lösung aufdecken (mit Rundenfortschritt)
  socket.on('mod:reveal-hint1', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (room.roundIndex !== 1 || room.turnUid) { io.to(socket.id).emit('status','Runde 1 noch nicht fertig.'); return; }
    room.reveals.hint1 = true;
    broadcastPartial(room, c, { reveals: room.reveals, question: roomState(room).question });
    // Starte Runde 2
    room.roundIndex = 2; resetRound(room);
    room.turnUid = startSeatUid(room);
    broadcastPartial(room, c, { roundIndex: room.roundIndex, turnUid: room.turnUid, actedCount: 0, needCount: countActivePlayers(room), currentBetRound: room.currentBetRound });
    io.in(c).emit('status','Hinweis 1 aufgedeckt. Runde 2 gestartet.');
  });
  socket.on('mod:reveal-hint2', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (room.roundIndex !== 2 || room.turnUid) { io.to(socket.id).emit('status','Runde 2 noch nicht fertig.'); return; }
    room.reveals.hint2 = true;
    broadcastPartial(room, c, { reveals: room.reveals, question: roomState(room).question });
    // Starte Runde 3
    room.roundIndex = 3; resetRound(room);
    room.turnUid = startSeatUid(room);
    broadcastPartial(room, c, { roundIndex: room.roundIndex, turnUid: room.turnUid, actedCount: 0, needCount: countActivePlayers(room), currentBetRound: room.currentBetRound });
    io.in(c).emit('status','Hinweis 2 aufgedeckt. Runde 3 gestartet.');
  });
  socket.on('mod:reveal-solution', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (room.roundIndex !== 3 || room.turnUid) { io.to(socket.id).emit('status','Runde 3 noch nicht fertig.'); return; }
    room.reveals.solution = true;
    broadcastPartial(room, c, { reveals: room.reveals, question: roomState(room).question });
    // Starte Runde 4 (finale Aktionen + Schätzantworten)
    room.roundIndex = 4; resetRound(room);
    room.turnUid = startSeatUid(room);
    broadcastPartial(room, c, { roundIndex: room.roundIndex, turnUid: room.turnUid, actedCount: 0, needCount: countActivePlayers(room), currentBetRound: room.currentBetRound });
    io.in(c).emit('status','Lösung aufgedeckt. Runde 4 (final) gestartet – jetzt schätzen & letzte Aktion!');
  });

  // Admin: Pot an Gewinner auszahlen (manuell)
  socket.on('mod:award-pot', ({ uid }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid);
    if (!p) { io.to(socket.id).emit('status','Gewinner nicht gefunden.'); return; }
    const pot = room.pot || 0;
    if (pot > 0) { p.chips = (p.chips||0) + pot; room.pot = 0; }
    // Bets zurücksetzen (nur rundenweise)
    for (const pl of room.players.values()) { pl.betRound = 0; }
    room.currentBetRound = 0;
    broadcastPartial(room, c, { pot: room.pot, currentBetRound: room.currentBetRound });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    io.in(c).emit('status', `🏆 Pot (${pot}) geht an ${p.name}.`);
  });

  // Admin: Nächstliegenden automatisch auszahlen (falls target vorhanden)
  socket.on('mod:award-nearest', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const q = room.questions?.[room.qIndex]; if (!q || typeof q.target !== 'number') { io.to(socket.id).emit('status','Kein Zielwert (target) in Frage.'); return; }
    // Nur aktive (nicht gefoldete) Spieler mit abgegebener estimate
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

  // Admin: Ergebnis/Chips manuell (bestehend)
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

  // Spieler: „Chat“-Antwort an Admin (bleibt wie gehabt)
  socket.on('player:answer', ({ answer }) => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    if (room.moderatorId) io.to(room.moderatorId).emit('answer:received', { uid:p.uid, name:p.name, answer: String(answer||'') });
  });

  // Spieler: Schätzantwort (finale Runde 4)
  socket.on('player:estimate', ({ value }) => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    if (room.roundIndex !== 4) { io.to(socket.id).emit('status','Schätzen erst in Runde 4.'); return; }
    const v = (value===null || value===undefined) ? null : Number(value);
    if (v===null || Number.isFinite(v)) {
      p.estimate = v;
      if (room.moderatorId) io.to(room.moderatorId).emit('status', `📩 Schätzantwort von ${p.name}: ${v===null?'(leer)':v}`);
      io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
    }
  });

  // ─────────── Spieler-Aktionen (nur am Zug!) ───────────
  socket.on('player:bet', ({ amount }) => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!requireTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p || p.status==='folded') return;

    const add = Math.max(1, parseInt(amount||'0',10)||0);
    const added = addToPot(room, p, add);
    if (!added) return;
    // Raise?
    if (p.betRound > room.currentBetRound) room.currentBetRound = p.betRound;
    markActedAndAdvance(room, uid);
    if (!room.turnUid) io.in(c).emit('status', `Runde ${room.roundIndex} komplett.`);
    broadcastPartial(room, c, {
      pot: room.pot, currentBetRound: room.currentBetRound,
      turnUid: room.turnUid, actedCount: room.acted.size, needCount: countActivePlayers(room)
    });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });

  socket.on('player:call', () => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!requireTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p || p.status==='folded') return;

    const need = Math.max(0, (room.currentBetRound||0) - (p.betRound||0));
    if (need > 0) addToPot(room, p, need);
    markActedAndAdvance(room, uid);
    if (!room.turnUid) io.in(c).emit('status', `Runde ${room.roundIndex} komplett.`);
    broadcastPartial(room, c, {
      pot: room.pot, currentBetRound: room.currentBetRound,
      turnUid: room.turnUid, actedCount: room.acted.size, needCount: countActivePlayers(room)
    });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });

  socket.on('player:allin', () => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!requireTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p || p.status==='folded') return;

    const added = addToPot(room, p, p.chips);
    p.status = 'allin';
    if (p.betRound > room.currentBetRound) room.currentBetRound = p.betRound;
    markActedAndAdvance(room, uid);
    if (!room.turnUid) io.in(c).emit('status', `Runde ${room.roundIndex} komplett.`);
    broadcastPartial(room, c, {
      pot: room.pot, currentBetRound: room.currentBetRound,
      turnUid: room.turnUid, actedCount: room.acted.size, needCount: countActivePlayers(room)
    });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
  });

  socket.on('player:fold', () => {
    const c = socket.data.room; const uid = socket.data.uid; const room = ensureRoom(c); if (!room) return;
    if (!requireTurn(socket, room)) return;
    const p = room.players.get(uid); if (!p) return;

    if (!canFold(room, p)) { io.to(socket.id).emit('status','SB/BB dürfen in Runde 1 nicht folden.'); return; }
    p.status = 'folded';
    markActedAndAdvance(room, uid);
    if (!room.turnUid) io.in(c).emit('status', `Runde ${room.roundIndex} komplett.`);
    broadcastPartial(room, c, { turnUid: room.turnUid, actedCount: room.acted.size, needCount: countActivePlayers(room) });
    io.in(c).emit('players:update', { version: ++room.version, players: roomState(room).players });
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
      if (room.turnUid === uid) { markActedAndAdvance(room, uid); broadcastPartial(room, c, { turnUid: room.turnUid }); }
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
