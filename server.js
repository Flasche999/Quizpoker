// server.js – QuizPoker v2 (stabilere Betting-Logik, Sounds, Dealer-Rotation)
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
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).type('text').send('OK'));

// ─────────────────────────────────────────────────────────────
// Konfiguration & State
// ─────────────────────────────────────────────────────────────
const MAX_SEATS   = 8;
const START_CHIPS = 1500;
const state = {
  players: {},                      // socketId -> {id,name,avatar,seat,chips,inHand,committed}
  seats: Array(MAX_SEATS).fill(null),
  table: {
    dealerSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    pot: 0,
    currentBet: 0,
    minRaise: 20,
    actingSeat: null,
    lastAggressorSeat: null,
  },
  round: {                         // Phasen: lobby | collect_guesses | bet1 | hint1 | bet2 | hint2 | bet3 | reveal | showdown
    phase: 'lobby',
    question: null,
    guesses: {},                  // socketId -> number (geheim)
    hintsRevealed: 0,
  },
};

// Fragen laden
const fragenPath = path.join(__dirname, 'public', 'fragen.json');
let FRAGEN = [];
try { FRAGEN = JSON.parse(fs.readFileSync(fragenPath, 'utf-8')); }
catch { FRAGEN = [{ id: 1, frage: 'Backup-Frage: Wie viele Minuten hat ein Tag?', hinweis1: 'Mehr als 1000.', hinweis2: 'Weniger als 2000.', loesung: 1440 }]; }

// ─────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────
function publicState() {
  const players = Object.fromEntries(
    Object.entries(state.players).map(([sid, p]) => [sid, {
      id: p.id, name: p.name, seat: p.seat, avatar: p.avatar,
      chips: p.chips, inHand: p.inHand, committed: p.committed||0,
      hasGuessed: !!state.round.guesses[sid],
    }])
  );
  return {
    players,
    seats: state.seats,
    table: { ...state.table },
    round: {
      phase: state.round.phase,
      hintsRevealed: state.round.hintsRevealed,
      question: state.round.question ? {
        id: state.round.question.id,
        frage: state.round.question.frage,
        hinweis1: state.round.hintsRevealed >= 1 ? state.round.question.hinweis1 : null,
        hinweis2: state.round.hintsRevealed >= 2 ? state.round.question.hinweis2 : null,
        loesung: ['reveal','showdown'].includes(state.round.phase) ? state.round.question.loesung : null,
      } : null,
      pot: state.table.pot,
      currentBet: state.table.currentBet,
      actingSeat: state.table.actingSeat,
    },
  };
}
function broadcast(){ io.emit('state', publicState()); }

function seated(){ return state.seats.map((sid,seat)=>({sid,seat})).filter(x=>sidExists(x.sid)); }
function active(){ return seated().filter(x=>state.players[x.sid].inHand); }
function sidExists(sid){ return !!(sid && state.players[sid]); }

function nextActiveSeat(from){
  for(let i=1;i<=MAX_SEATS;i++){
    const s = (from + i) % MAX_SEATS;
    const sid = state.seats[s];
    if (sidExists(sid) && state.players[sid].inHand) return s;
  }
  return null;
}

function resetBets(){
  state.table.currentBet = 0;
  state.table.minRaise   = state.table.bigBlind;
  state.table.lastAggressorSeat = null;
  for(const {sid} of seated()){ if(sidExists(sid)) state.players[sid].committed = 0; }
}

function postBlinds(){
  const act = active();
  if (act.length < 2) return;
  const sbSeat = nextActiveSeat(state.table.dealerSeat);
  const bbSeat = nextActiveSeat(sbSeat);
  const sbSid = state.seats[sbSeat];
  const bbSid = state.seats[bbSeat];
  const SB = state.table.smallBlind, BB = state.table.bigBlind;
  for(const [sid,amt] of [[sbSid,SB],[bbSid,BB]]){
    const p = state.players[sid];
    const pay = Math.min(p.chips, amt);
    p.chips -= pay;
    p.committed = (p.committed||0) + pay;
    state.table.pot += pay;
  }
  state.table.currentBet = Math.max(SB, BB);
  state.table.minRaise = BB;
  // Erste Action: Spieler nach BB
  state.table.actingSeat = nextActiveSeat(bbSeat);
}

function everyoneDone(){
  const actives = active();
  if (actives.length <= 1) return true;
  return actives.every(({sid})=>{
    const p = state.players[sid];
    return (!p.inHand) || (p.chips===0) || ((p.committed||0) === state.table.currentBet);
  });
}

function goNextActor(){
  const cur = state.table.actingSeat;
  if (cur==null) return;
  const next = nextActiveSeat(cur);
  state.table.actingSeat = next;
}

function finishBettingPhase(){
  state.table.actingSeat = null;
}

function newHandSetup(){
  for(const {sid} of seated()){
    if (!sidExists(sid)) continue;
    state.players[sid].inHand = state.players[sid].chips > 0;
    state.players[sid].committed = 0;
  }
  state.table.pot = 0;
  resetBets();
  const nextDealer = nextActiveSeat(state.table.dealerSeat ?? 0);
  state.table.dealerSeat = nextDealer ?? state.table.dealerSeat;
}

function autoWinner(){
  const sol = Number(state.round.question?.loesung);
  if (!Number.isFinite(sol)) return null;
  let best=null;
  for(const {sid} of active()){
    const g = Number(state.round.guesses[sid]);
    if (!Number.isFinite(g)) continue;
    const diff = Math.abs(g - sol);
    if (!best || diff < best.diff) best = { sid, diff };
  }
  return best?.sid || null;
}

// ─────────────────────────────────────────────────────────────
// Socket.IO – Spieler
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', ({ name, avatar }) => {
    name = String(name||'').trim().slice(0,20) || 'Spieler';
    avatar = String(avatar||'').trim().slice(0,200);
    const seat = state.seats.findIndex(x=>x===null);
    if (seat === -1) return socket.emit('errorMsg', 'Tisch ist voll.');

    state.seats[seat] = socket.id;
    state.players[socket.id] = { id: socket.id, name, avatar, seat, chips: START_CHIPS, inHand: false, committed: 0 };
    socket.emit('joined', { seat });
    broadcast();
  });

  socket.on('leaveTable', () => {
    const p = state.players[socket.id];
    if (!p) return;
    state.seats[p.seat] = null;
    delete state.players[socket.id];
    delete state.round.guesses[socket.id];
    broadcast();
  });

  socket.on('submitGuess', ({ value }) => {
    if (state.round.phase !== 'collect_guesses') return;
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    if (!sidExists(socket.id)) return;

    state.round.guesses[socket.id] = num;
    broadcast();

    const actives = seated();
    const allSubmitted = actives.length>0 && actives.every(({sid})=> state.round.guesses[sid]!==undefined);
    if (allSubmitted) {
      state.round.phase = 'bet1';
      resetBets();
      for (const {sid} of seated()) if (sidExists(sid)) state.players[sid].inHand = state.players[sid].chips>0;
      postBlinds();
      broadcast();
    }
  });

  socket.on('action', ({ type, amount }) => {
    const valid = ['bet1','bet2','bet3'];
    if (!valid.includes(state.round.phase)) return;
    if (!sidExists(socket.id)) return;
    const p = state.players[socket.id];
    if (!p.inHand) return;
    if (state.seats[state.table.actingSeat] !== socket.id) return;

    const toCall = Math.max(0, state.table.currentBet - (p.committed||0));

    if (type === 'fold') {
      p.inHand = false;
      const activesLeft = active();
      if (activesLeft.length <= 1) finishBettingPhase();
      else { goNextActor(); }
      broadcast();
      return;
    }

    if (type === 'check') {
      if (toCall !== 0) return;
      goNextActor();
      if (everyoneDone()) finishBettingPhase();
      broadcast();
      return;
    }

    if (type === 'call') {
      const pay = Math.min(p.chips, toCall);
      p.chips -= pay; p.committed = (p.committed||0) + pay; state.table.pot += pay;
      goNextActor();
      if (everyoneDone()) finishBettingPhase();
      broadcast();
      return;
    }

    if (type === 'raise' || type === 'bet') {
      amount = Number(amount);
      if (!Number.isFinite(amount)) return;
      const target = Math.max(state.table.currentBet + state.table.minRaise, amount);
      const need   = Math.max(0, target - (p.committed||0));
      const pay    = Math.min(p.chips, need);
      if (pay <= 0) return;

      p.chips -= pay; p.committed = (p.committed||0) + pay; state.table.pot += pay;
      state.table.currentBet = Math.max(state.table.currentBet, p.committed);
      state.table.lastAggressorSeat = p.seat;
      state.table.minRaise = Math.max(state.table.minRaise, state.table.bigBlind);

      goNextActor();
      broadcast();
      return;
    }

    if (type === 'allin') {
      if (p.chips <= 0) return;
      const pay = p.chips;
      p.chips = 0; p.committed = (p.committed||0) + pay; state.table.pot += pay;
      if (p.committed > state.table.currentBet) {
        state.table.currentBet = p.committed;
        state.table.lastAggressorSeat = p.seat;
      }
      goNextActor();
      broadcast();
      return;
    }
  });

  socket.on('rebuy', () => {
    if (!sidExists(socket.id)) return;
    const p = state.players[socket.id];
    p.chips += START_CHIPS;
    broadcast();
  });

  socket.on('disconnect', () => {
    const p = state.players[socket.id];
    if (!p) return;
    state.seats[p.seat] = null;
    delete state.players[socket.id];
    delete state.round.guesses[socket.id];
    broadcast();
  });
});

// ─────────────────────────────────────────────────────────────
// Admin-Namespace
// ─────────────────────────────────────────────────────────────
const admin = io.of('/admin');
admin.on('connection', socket => {
  socket.emit('state', publicState());

  socket.on('startRound', ({ questionId }) => {
    const q = FRAGEN.find(f => String(f.id) === String(questionId)) || FRAGEN[0];
    state.round.phase = 'collect_guesses';
    state.round.question = q;
    state.round.hintsRevealed = 0;
    state.round.guesses = {};
    newHandSetup();
    admin.emit('state', publicState());
    broadcast();
  });

  socket.on('revealHint', (n) => {
    if (n === 1 && state.round.phase === 'bet1') {
      state.round.hintsRevealed = 1;
      state.round.phase = 'hint1';
      admin.emit('sound', { key: 'buzzer' });
      state.round.phase = 'bet2';
      resetBets();
      state.table.actingSeat = nextActiveSeat(state.table.dealerSeat);
    }
    if (n === 2 && state.round.phase === 'bet2') {
      state.round.hintsRevealed = 2;
      state.round.phase = 'hint2';
      admin.emit('sound', { key: 'buzzer' });
      state.round.phase = 'bet3';
      resetBets();
      state.table.actingSeat = nextActiveSeat(state.table.dealerSeat);
    }
    admin.emit('state', publicState());
    broadcast();
  });

  socket.on('goReveal', () => {
    state.round.phase = 'reveal';
    admin.emit('state', publicState());
    broadcast();
  });

  socket.on('resolveWinner', () => {
    const w = autoWinner();
    if (w) {
      state.players[w].chips += state.table.pot;
      state.table.pot = 0;
      admin.emit('sound', { key: 'correct' });
    }
    state.round.phase = 'showdown';
    admin.emit('winner', { winnerSid: w, solution: state.round.question?.loesung });
    admin.emit('state', publicState());
    broadcast();
  });

  socket.on('playSound', ({ key }) => {
    admin.emit('sound', { key });
    io.emit('sound', { key });
  });
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Listening on :' + PORT));
