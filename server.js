// server.js – QuizPoker (ESM)
// Features:
// - Räume mit Lobby (alle Spieler + Admin sehen alle)
// - Sitzplätze (0–7) am virtuellen Tisch
// - Einzigartige Namen pro Raum
// - Kein Doppelplatz: UID wird einmalig geführt
// - Reconnect erlaubt, Takeover kickt alte Verbindung derselben UID
// - Blinds (small/big) + turnUid (wer ist dran)
// - NEU: Betting (Bet/Call/Fold/All-in), Live-Pot, Bets pro Spieler
// - NEU: Soft-Handling, wenn Moderator disconnectet + mod:claim-room
// - NEU: Pot-Auszahlung an Gewinner (mod:award-pot)

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

// Optional: Fragen laden
function loadQuestions() {
  const p = path.join(__dirname, 'public', 'fragen.json');
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    console.error('fragen.json laden fehlgeschlagen:', e.message);
  }
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
    moderatorId,               // Admin-Socket-ID (oder null)
    version,
    players: Map<uid, { uid, name, chips, connected, socketId, seat, bet, status }>,
    questions: [...],
    qIndex: number,            // -1 bevor gestartet
    pot: number,
    currentBet: number,        // höchste Bet in der aktuellen Runde
    blinds: { small: number|null, big: number|null },
    turnUid: string|null,
    closeTimer?: NodeJS.Timeout|null
  }
*/

function roomState(room) {
  return {
    code: room.code,
    version: room.version || 0,
    pot: room.pot || 0,
    currentBet: room.currentBet || 0,
    qIndex: room.qIndex ?? -1,
    blinds: room.blinds || { small: null, big: null },
    turnUid: room.turnUid || null,
    players: Array.from(room.players.values()).map(p => ({
      uid: p.uid,
      name: p.name,
      chips: p.chips,
      connected: !!p.connected,
      seat: typeof p.seat === 'number' ? p.seat : null,
      bet: p.bet || 0,
      status: p.status || 'active'  // active | folded | allin
    })),
    question: room.questions?.[room.qIndex] ? {
      index: room.qIndex,
      text: room.questions[room.qIndex].text || '',
    } : null
  };
}
const bump = (room) => { room.version = (room.version || 0) + 1; };
const ensureRoom = (code) => rooms.get(code) || null;

// Sitz-/Hilfsfunktionen
function seatIsFree(room, idx) {
  for (const p of room.players.values()) if (p.seat === idx) return false;
  return true;
}
function nextFreeSeat(room) {
  for (let i = 0; i < MAX_SEATS; i++) if (seatIsFree(room, i)) return i;
  return -1;
}
function findUidBySeat(room, seat) {
  for (const p of room.players.values()) if (p.seat === seat) return p.uid;
  return null;
}
function resetBets(room) {
  room.currentBet = 0;
  room.pot = 0;
  for (const p of room.players.values()) {
    p.bet = 0;
    p.status = 'active';
  }
}
function addToPot(room, p, amount) {
  const amt = Math.max(0, Math.min(Number(amount) || 0, p.chips));
  if (!amt) return 0;
  p.chips -= amt;
  p.bet = (p.bet || 0) + amt;
  room.pot = (room.pot || 0) + amt;
  return amt;
}

// ─────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  // Admin erstellt Raum (als Lobby desselben Codes)
  socket.on('mod:create-room', () => {
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code,
      moderatorId: socket.id,
      version: 0,
      players: new Map(),
      questions: loadQuestions(),
      qIndex: -1,
      pot: 0,
      currentBet: 0,
      blinds: { small: null, big: null },
      turnUid: null,
      closeTimer: null
    };
    rooms.set(code, room);

    socket.join(code);
    socket.data = { role: 'moderator', room: code };

    io.to(socket.id).emit('mod:room-created', { code, state: roomState(room) });
    console.log('[ROOM] created', code);
  });

  // Moderator übernimmt (erneut) einen bestehenden Raum
  socket.on('mod:claim-room', ({ code }) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { io.to(socket.id).emit('status', 'Raum nicht gefunden.'); return; }

    room.moderatorId = socket.id;
    if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; }

    socket.join(code);
    socket.data = { role: 'moderator', room: code };

    io.to(socket.id).emit('state:full', roomState(room));
    io.in(code).emit('status', 'Moderator ist wieder da.');
    console.log('[ROOM] moderator claimed', code, '->', socket.id);
  });

  // Admin setzt Blinds (optional)
  socket.on('mod:set-blinds', ({ small, big }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const sSeat = (Number.isInteger(small) ? small : null);
    const bSeat = (Number.isInteger(big)   ? big   : null);
    room.blinds = { small: sSeat, big: bSeat };
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, blinds: room.blinds });
    console.log('[BLINDS]', c, room.blinds);
  });

  // Admin setzt „wer ist am Zug“
  socket.on('mod:set-turn', ({ uid, seat }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    let targetUid = uid || null;
    if (!targetUid && Number.isInteger(seat)) targetUid = findUidBySeat(room, seat);
    if (!targetUid || !room.players.has(targetUid)) {
      io.to(socket.id).emit('status', 'Konnte Turn nicht setzen: UID/Seat ungültig.');
      return;
    }
    room.turnUid = targetUid;
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, turnUid: room.turnUid });
    console.log('[TURN]', c, '->', room.turnUid);
  });

  // Admin nächste Frage (setzt Bets/Pot zurück + zeigt Frage)
  socket.on('mod:next-question', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (!room.questions || room.questions.length === 0) return;

    if (room.qIndex + 1 < room.questions.length) {
      room.qIndex += 1;
      // Neue Schätzfrage → Betting-Reset
      resetBets(room);
      bump(room);
      io.in(c).emit('state:partial', {
        version: room.version,
        pot: room.pot,
        currentBet: room.currentBet
      });
      io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });

      io.in(c).emit('question:show', {
        version: room.version,
        index: room.qIndex,
        text: room.questions[room.qIndex].text || ''
      });
    } else {
      io.in(c).emit('status', '🎉 Alle Fragen durch!');
    }
  });

  // Admin: Pot an Gewinner auszahlen (UID)
  socket.on('mod:award-pot', ({ uid }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid);
    if (!p) { io.to(socket.id).emit('status', 'Gewinner nicht gefunden.'); return; }

    const pot = room.pot || 0;
    if (pot > 0) {
      p.chips = (p.chips || 0) + pot;
      room.pot = 0;
    }
    // Runde schließen/resetten (Bets zurück)
    for (const pl of room.players.values()) { pl.bet = 0; if (pl.status !== 'disconnected') pl.status = 'active'; }
    room.currentBet = 0;

    bump(room);
    io.in(c).emit('state:partial', { version: room.version, pot: room.pot, currentBet: room.currentBet });
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
    io.in(c).emit('status', `🏆 Pot (${pot}) geht an ${p.name}.`);
  });

  // Admin markiert Ergebnis (bleibt erhalten)
  socket.on('mod:mark', ({ uid, result, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;

    const d = Number(delta);
    if (Number.isFinite(d) && d !== 0) p.chips = Math.max(0, (p.chips || 0) + d);

    bump(room);
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
    io.in(c).emit(result === 'correct' ? 'result:correct' : 'result:wrong', { uid, name: p.name, delta: d||0 });
  });

  // Admin manuell Chips ±
  socket.on('mod:adjust', ({ uid, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const d = Number(delta); if (!Number.isFinite(d) || d === 0) return;
    p.chips = Math.max(0, (p.chips || 0) + d);
    bump(room);
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Admin: Full-State an alle
  socket.on('mod:sync-all', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    io.in(c).emit('state:full', roomState(room));
  });

  // Spieler: Reconnect/Backfill – erstellt KEINE neuen Spieler
  socket.on('hello', ({ uid, room: code }) => {
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    const p = room.players.get(uid);
    if (!p) { io.to(socket.id).emit('state:full', roomState(room)); return; }

    p.connected = true;
    p.socketId  = socket.id;
    socket.join(code);
    socket.data = { role: 'player', room: code, uid };
    io.to(socket.id).emit('state:full', roomState(room));
    bump(room);
    io.in(code).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Spieler tritt der Lobby des Raums bei
  socket.on('player:join', ({ code, uid, name }) => {
    code = String(code || '').toUpperCase().trim();
    console.log('[JOIN] request', { code, uid, name, sid: socket.id });

    if (!rooms.has(code)) {
      return io.to(socket.id).emit('player:join-result', { ok: false, error: 'Raum nicht gefunden.' });
    }
    const room = rooms.get(code);

    // vorhandener Eintrag?
    let existing = room.players.get(uid);

    // Takeover
    if (existing && existing.connected) {
      const oldSockId = existing.socketId;
      const oldSock = oldSockId && io.sockets.sockets.get(oldSockId);
      if (oldSock) {
        io.to(oldSockId).emit('status', 'Du wurdest durch eine neue Verbindung abgelöst.');
        try { oldSock.disconnect(true); } catch {}
        console.log('[JOIN] takeover', { code, uid, oldSockId, newSockId: socket.id });
      }
    }

    // Name eindeutig (außer es ist dieselbe UID)
    const desiredName = String(name || 'Spieler').slice(0, 24);
    if (Array.from(room.players.values()).some(p =>
      p.uid !== uid && (p.name || '').trim().toLowerCase() === desiredName.trim().toLowerCase()
    )) {
      return io.to(socket.id).emit('player:join-result', { ok: false, error: 'Dieser Name ist bereits vergeben.' });
    }

    // anlegen/übernehmen
    let p = existing;
    if (!p) {
      const seat = nextFreeSeat(room);
      if (seat === -1) {
        return io.to(socket.id).emit('player:join-result', { ok: false, error: 'Tisch ist voll (8/8).' });
      }
      p = {
        uid, name: desiredName, chips: 100,
        connected: true, socketId: socket.id, seat,
        bet: 0, status: 'active'
      };
      room.players.set(uid, p);
      if (!room.turnUid) room.turnUid = uid;
      console.log('[JOIN] new', { code, uid, name: p.name, seat: p.seat });
    } else {
      p.connected = true;
      p.socketId  = socket.id;
      p.name      = desiredName;
      console.log('[JOIN] reconnect', { code, uid, name: p.name, seat: p.seat });
    }

    socket.join(code);
    socket.data = { role: 'player', room: code, uid };

    io.to(socket.id).emit('player:join-result', {
      ok: true, code, uid: p.uid, name: p.name, chips: p.chips, seat: p.seat
    });
    io.to(socket.id).emit('state:full', roomState(room));

    bump(room);
    io.in(code).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Spieler-Antwort (an Admin)
  socket.on('player:answer', ({ answer }) => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    if (room.moderatorId) {
      io.to(room.moderatorId).emit('answer:received', {
        uid: p.uid, name: p.name, answer: String(answer || '')
      });
    }
  });

  // ─────────────── NEU: Betting-Events (Player) ───────────────
  socket.on('player:bet', ({ amount }) => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p || p.status === 'folded') return;

    const added = addToPot(room, p, Number(amount));
    if (!added) return;

    if (p.bet > room.currentBet) room.currentBet = p.bet;
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, pot: room.pot, currentBet: room.currentBet });
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  socket.on('player:call', () => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p || p.status === 'folded') return;

    const need = Math.max(0, (room.currentBet || 0) - (p.bet || 0));
    if (need <= 0) return;
    addToPot(room, p, need);
    // currentBet bleibt gleich
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, pot: room.pot, currentBet: room.currentBet });
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  socket.on('player:allin', () => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p || p.status === 'folded') return;

    const added = addToPot(room, p, p.chips);
    p.status = 'allin';
    if (p.bet > room.currentBet) room.currentBet = p.bet;
    if (!added) return;
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, pot: room.pot, currentBet: room.currentBet });
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  socket.on('player:fold', () => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;

    p.status = 'folded';
    bump(room);
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Disconnect
  socket.on('disconnect', (reason) => {
    const c = socket.data?.room;
    console.log('[SOCKET] disconnect', socket.id, reason);
    if (!c || !rooms.has(c)) return;
    const room = rooms.get(c);
    const role = socket.data?.role;

    if (role === 'moderator') {
      const was = room.moderatorId;
      room.moderatorId = null;
      io.in(c).emit('status', 'Moderator kurz weg – Raum bleibt bestehen.');

      if (room.closeTimer) clearTimeout(room.closeTimer);
      room.closeTimer = setTimeout(() => {
        if (!room.moderatorId) {
          io.in(c).emit('status', 'Raum wurde beendet (Moderator nicht zurückgekehrt).');
          io.in(c).socketsLeave(c);
          rooms.delete(c);
          console.log('[ROOM] closed (timeout)', c);
        }
      }, 5 * 60 * 1000);

      console.log('[ROOM] moderator left (soft)', c, 'prev=', was);
      return;
    }

    const uid = socket.data?.uid;
    if (uid && room.players.has(uid)) {
      const p = room.players.get(uid);
      if (p.socketId === socket.id) p.socketId = null;
      p.connected = false;
      bump(room);
      io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });

      if (room.turnUid === uid) {
        room.turnUid = null;
        bump(room);
        io.in(c).emit('state:partial', { version: room.version, turnUid: room.turnUid });
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
