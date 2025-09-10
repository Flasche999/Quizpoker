// server.js – QuizPoker, robust mit UID, State-Backfill & Versionierung (ESM)

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

// Fragen laden (optional)
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

const rooms = new Map();
/*
  room = {
    code,
    moderatorId,
    version,
    players: Map<uid, { uid, name, chips, connected, socketId }>,
    questions: [...],
    qIndex: number, // -1 bevor gestartet
    pot: number,
    blinds: { small: null, big: null }, // optional nach Name oder UID
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
      uid: p.uid, name: p.name, chips: p.chips, connected: !!p.connected
    })),
    // Schicke nur Metadaten der Frage, nicht die Lösung (optional)
    question: room.questions?.[room.qIndex] ? {
      index: room.qIndex,
      text: room.questions[room.qIndex].text || '',
      // answers: room.questions[room.qIndex].answers || [] // falls Multiple Choice
    } : null
  };
}

function bump(room) { room.version = (room.version || 0) + 1; }

function ensureRoom(code) {
  if (!rooms.has(code)) return null;
  return rooms.get(code);
}

// ─────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Moderator erstellt Raum
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
  });

  // Moderator setzt Blinds (optional, per Name)
  socket.on('mod:set-blinds', ({ small, big }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    room.blinds = { small: small || null, big: big || null };
    bump(room);
    io.in(c).emit('state:partial', { version: room.version, blinds: room.blinds });
  });

  // Moderator setzt nächste Frage
  socket.on('mod:next-question', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    if (!room.questions || room.questions.length === 0) return;

    // nächste Frage
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

  // Moderator markiert Ergebnis (korrekt/falsch) & Chips delta
  socket.on('mod:mark', ({ uid, result, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;

    const d = Number(delta);
    if (Number.isFinite(d) && d !== 0) p.chips = Math.max(0, (p.chips || 0) + d);

    bump(room);
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
    io.in(c).emit(result === 'correct' ? 'result:correct' : 'result:wrong', { uid, name: p.name, delta: d||0 });
  });

  // Moderator manuell Chips ±
  socket.on('mod:adjust', ({ uid, delta }) => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;
    const d = Number(delta); if (!Number.isFinite(d) || d === 0) return;
    p.chips = Math.max(0, (p.chips || 0) + d);
    bump(room);
    io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Moderator: alle synchronisieren (State-Backfill an alle)
  socket.on('mod:sync-all', () => {
    const c = socket.data.room; const room = ensureRoom(c); if (!room) return;
    const state = roomState(room);
    // Nur state:full an alle schicken (Clients rendern ohne reload)
    io.in(c).emit('state:full', state);
  });

  // Spieler meldet sich (Reconnect-tauglich) – optional schon mit room & name
  socket.on('hello', ({ uid, name, room: code }) => {
    // hello ist optional; eigentlicher Join passiert unten über player:join
    // falls der Client aber schon Code kennt, kann man das hier nutzen:
    if (!code) return;
    if (!rooms.has(code)) return;

    const room = rooms.get(code);
    let p = room.players.get(uid);
    if (!p) {
      p = { uid, name: name || 'Spieler', chips: 100, connected: true, socketId: socket.id };
      room.players.set(uid, p);
    } else {
      p.connected = true;
      p.socketId = socket.id;
      if (name) p.name = name;
    }
    socket.join(code);
    socket.data = { role: 'player', room: code, uid };

    io.to(socket.id).emit('state:full', roomState(room));
    bump(room);
    io.in(code).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Spieler tritt bei
  socket.on('player:join', ({ code, uid, name }) => {
    code = String(code || '').toUpperCase().trim();
    if (!rooms.has(code)) {
      return io.to(socket.id).emit('player:join-result', { ok: false, error: 'Raum nicht gefunden.' });
    }
    const room = rooms.get(code);

    // Spielerobjekt anlegen/holen
    let p = room.players.get(uid);
    if (!p) {
      p = { uid, name: String(name || 'Spieler').slice(0, 24), chips: 100, connected: true, socketId: socket.id };
      room.players.set(uid, p);
    } else {
      p.connected = true;
      p.socketId = socket.id;
      if (name) p.name = String(name).slice(0, 24);
    }

    socket.join(code);
    socket.data = { role: 'player', room: code, uid };

    io.to(socket.id).emit('player:join-result', { ok: true, code, uid: p.uid, name: p.name, chips: p.chips });
    io.to(socket.id).emit('state:full', roomState(room));

    bump(room);
    io.in(code).emit('players:update', { version: room.version, players: roomState(room).players });
  });

  // Spieler Antwort (nur an Moderator weiterleiten)
  socket.on('player:answer', ({ answer }) => {
    const c = socket.data.room; const uid = socket.data.uid;
    const room = ensureRoom(c); if (!room) return;
    const p = room.players.get(uid); if (!p) return;

    // Moderator benachrichtigen
    io.to(room.moderatorId).emit('answer:received', {
      uid: p.uid, name: p.name, answer: String(answer || '')
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const c = socket.data?.room; if (!c || !rooms.has(c)) return;
    const room = rooms.get(c);
    const role = socket.data?.role;

    if (role === 'moderator') {
      io.in(c).emit('status', 'Moderator hat den Raum verlassen. Spiel beendet.');
      io.in(c).socketsLeave(c);
      rooms.delete(c);
      return;
    }

    // Spieler: nicht löschen – nur als offline markieren
    const uid = socket.data?.uid;
    if (uid && room.players.has(uid)) {
      const p = room.players.get(uid);
      if (p.socketId === socket.id) p.socketId = null;
      p.connected = false;
      bump(room);
      io.in(c).emit('players:update', { version: room.version, players: roomState(room).players });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('QuizPoker listening on :' + PORT));
