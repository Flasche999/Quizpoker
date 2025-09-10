// server.js – QuizPoker (ESM)
// Features:
// - Räume mit Lobby (alle Spieler + Admin sehen alle)
// - Sitzplätze (0–7) am virtuellen Tisch
// - Einzigartige Namen pro Raum
// - Kein Doppelplatz: UID wird einmalig geführt
// - Reconnect erlaubt, Takeover kickt alte Verbindung derselben UID

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
  pingTimeout: 20000
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
    players: Map<uid, { uid, name, chips, connected, socketId, seat }>,
    questions: [...],
    qIndex: number,            // -1 bevor gestartet
    pot: number,
    blinds: { small: null, big: null },
  }
*/

function roomState(room) {
  return {
    code: room.code,
    version: room.version || 0,
    pot: room.pot || 0,
    qIndex: room.qIndex ?? -1,
    blinds: room.blinds || { small: null, big: null },
    players: Array.from(room.players.values()).map(p => ({
      uid: p.uid,
      name: p.name,
      chips: p.chips,
      connected: !!p.connected,
      seat: typeof p.seat === 'number' ? p.seat : null
    })),
    question: room.questions?.[room.qIndex] ? {
      index: room.qIndex,
      text: room.questions[room.qIndex].text || '',
    } : null
  };
}
const bump = (room) => { room.version = (room.version || 0) + 1; };
const ensureRoom = (code) => rooms.get(code) || null;

// Sitz-Utils
function seatIsFree(room, idx) {
  for (const p of room.players.values()) if (p.seat === idx) return false;
  return true;
}
function nextFreeSeat(room) {
  for (let i = 0; i < MAX_SEATS; i++) if (seatIsFree(room, i)) return i;
  return -1;
}
function nameTaken(room, name, byUid = null) {
  const n = (name || '').trim().toLowerCase();
  for (const p of room.players.values()) {
    if (byUid && p.uid === byUid) continue;
    if ((p.name || '').trim().toLowerCase() === n) return true;
  }
  return false;
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
      blinds: { small: null, big: null }
    };
    rooms.set(code, room);

    socket.join(code);
    socket.data = { role: 'moderator', room: code };

    io.to(socket.id).emit('mod:room-created', { code, state: roomState(room) });
    console.log('[ROOM] created', code);
  });

  // Admin setzt Blinds (optional)
  socket.on('mod:set-blinds', ({ small, big }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    room.blinds = { small: small || null, big: big || null };
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, blinds: room.blinds });
  });

  // Admin nächste Frage
  socket.on('mod:next-question', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (!room.questions || room.questions.length === 0) return;

    if (room.qIndex + 1 < room.questions.length) {
      room.qIndex += 1;
      bump(room);
      io.in(c).emit('question:show', {
        version: room.version,
        index: room.qIndex,
        text: room.questions[room.qIndex].text || ''
      });
    } else {
      io.in(c).emit('status', '🎉 Alle Fragen durch!');
    }
  });

  // Admin markiert Ergebnis
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

    // Takeover: gleiche UID noch connected → alte Verbindung kicken
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
      p = { uid, name: desiredName, chips: 100, connected: true, socketId: socket.id, seat };
      room.players.set(uid, p);
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

  // Spieler Antwort (an Admin, falls vorhanden)
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

  // Disconnect
  socket.on('disconnect', (reason) => {
    const c = socket.data?.room;
    console.log('[SOCKET] disconnect', socket.id, reason);
    if (!c || !rooms.has(c)) return;
    const room = rooms.get(c);
    const role = socket.data?.role;

    if (role === 'moderator') {
      io.in(c).emit('status', 'Moderator hat den Raum verlassen. Spiel beendet.');
      io.in(c).socketsLeave(c);
      rooms.delete(c);
      console.log('[ROOM] closed', c, 'moderator left');
      return;
    }

    const uid = socket.data?.uid;
    if (uid && room.players.has(uid)) {
      const p = room.players.get(uid);
      if (p.socketId === socket.id) p.socketId = null;
      p.connected = false;           // bleibt im Raum sichtbar, aber „offline“
      bump(room);
      io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
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
