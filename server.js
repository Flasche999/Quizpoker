// server.js – QuizPoker v2.3
// Features: 6-Sitz-Tisch, Admin-only Chips/Rebuys, zensierte Schätzungen (Players),
// Admin sieht Schätzungen immer im Klartext, SB/BB-Sperre in Bet1,
// stabile Betting-Logik, Action-Broadcasts, OUT-Status,
// Bots (add/remove), Reveal-Bet-Phase nach Lösung, Auto-Showdown

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
const MAX_SEATS   = 6;            // <<< nur noch 6 Plätze (0..5) – 2/6 komplett entfernt
const START_CHIPS = 1500;

const state = {
  players: {},   // sid -> {id,name,avatar,seat,chips,inHand,committed,isOut,lastAction,isBot}
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
    sbSeat: null,
    bbSeat: null,
  },
  // Phasen: lobby | collect_guesses | bet1 | hint1 | bet2 | hint2 | bet3 | reveal | reveal_bet | showdown
  round: {
    phase: 'lobby',
    question: null,
    guesses: {},         // sid -> number
    guessRevealed: {},   // sid -> bool (für Playersicht)
    hintsRevealed: 0,
  },
};

// Fragen laden
const fragenPath = path.join(__dirname, 'public', 'fragen.json');
let FRAGEN = [];
try {
  FRAGEN = JSON.parse(fs.readFileSync(fragenPath, 'utf-8'));
} catch {
  FRAGEN = [{
    id: 1,
    frage: 'Backup-Frage: Wie viele Minuten hat ein Tag?',
    hinweis1: 'Mehr als 1000.',
    hinweis2: 'Weniger als 2000.',
    loesung: 1440
  }];
}

// ─────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────
function roleForSeat(seat) {
  if (seat === state.table.sbSeat) return 'SB';
  if (seat === state.table.bbSeat) return 'BB';
  return null;
}

function publicPlayers() {
  return Object.fromEntries(
    Object.entries(state.players).map(([sid, p]) => [sid, {
      id: p.id, name: p.name, seat: p.seat, avatar: p.avatar,
      chips: p.chips, inHand: p.inHand, committed: p.committed||0,
      hasGuessed: state.round.guesses[sid] !== undefined,
      role: roleForSeat(p.seat),
      isOut: !!p.isOut,
      lastAction: p.lastAction || null,
      isBot: !!p.isBot,
    }])
  );
}

function publicQuestion() {
  if (!state.round.question) return null;
  return {
    id: state.round.question.id,
    frage: state.round.question.frage,
    hinweis1: state.round.hintsRevealed >= 1 ? state.round.question.hinweis1 : null,
    hinweis2: state.round.hintsRevealed >= 2 ? state.round.question.hinweis2 : null,
    loesung: ['reveal','reveal_bet','showdown'].includes(state.round.phase) ? state.round.question.loesung : null,
  };
}

function publicGuessesForPlayers() {
  // Spieler sehen nur zensiert, außer Admin hat exakt diesen Spieler freigegeben
  return Object.entries(state.round.guesses).map(([sid, val]) => ({
    sid,
    name: state.players[sid]?.name || '???',
    value: state.round.guessRevealed[sid] ? String(val) : '•••',
    revealed: !!state.round.guessRevealed[sid],
  }));
}

function adminGuessesFull() {
  // Admin sieht immer Klartext + Reveal-Flag (für Spieler)
  return Object.entries(state.round.guesses).map(([sid, val]) => ({
    sid,
    name: state.players[sid]?.name || '???',
    value: String(val),
    revealed: !!state.round.guessRevealed[sid],
  }));
}

function publicState() {
  return {
    players: publicPlayers(),
    seats: state.seats,
    table: {
      dealerSeat: state.table.dealerSeat,
      smallBlind: state.table.smallBlind,
      bigBlind: state.table.bigBlind,
      pot: state.table.pot,
      currentBet: state.table.currentBet,
      minRaise: state.table.minRaise,
      actingSeat: state.table.actingSeat,
      sbSeat: state.table.sbSeat,
      bbSeat: state.table.bbSeat,
    },
    round: {
      phase: state.round.phase,
      hintsRevealed: state.round.hintsRevealed,
      question: publicQuestion(),
      hasAnyGuesses: Object.keys(state.round.guesses).length > 0,
    },
  };
}

function broadcast(){
  io.emit('state', publicState());
  io.emit('guesses:public', publicGuessesForPlayers()); // für alle Spieler
  admin.emit('admin:guesses', adminGuessesFull());      // Admin immer Klartext
}

function sidExists(sid){ return !!(sid && state.players[sid]); }
function seated(){ return state.seats.map((sid,seat)=>({sid,seat})).filter(x=>sidExists(x.sid)); }
function active(){ return seated().filter(x=>state.players[x.sid].inHand); }

function nextActiveSeat(from){
  if (from == null) return null;
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
  for(const {sid} of seated()){
    if (sidExists(sid)) state.players[sid].committed = 0;
  }
}

function postBlinds(){
  const act = active();
  if (act.length < 2) { state.table.sbSeat = null; state.table.bbSeat = null; return; }
  const sbSeat = nextActiveSeat(state.table.dealerSeat);
  const bbSeat = nextActiveSeat(sbSeat);
  state.table.sbSeat = sbSeat;
  state.table.bbSeat = bbSeat;

  const sbSid = state.seats[sbSeat];
  const bbSid = state.seats[bbSeat];
  const SB = state.table.smallBlind, BB = state.table.bigBlind;

  for (const [sid,amt] of [[sbSid,SB],[bbSid,BB]]) {
    const p = state.players[sid];
    const pay = Math.min(p.chips, amt);
    p.chips -= pay;
    p.committed = (p.committed||0) + pay;
    state.table.pot += pay;
    if (p.chips <= 0) p.isOut = true; // blind all-in -> nach Hand OUT
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
    const p = state.players[sid];
    p.inHand = (p.chips > 0) && !p.isOut;
    p.committed = 0;
    p.lastAction = null;
  }
  state.table.pot = 0;
  resetBets();
  // Dealer-Rotation: nächster aktiver Spieler
  const nextDealer = nextActiveSeat(state.table.dealerSeat ?? 0) ?? nextActiveSeat(-1);
  if (nextDealer != null) state.table.dealerSeat = nextDealer;
}

function autoWinnerSid(){
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

function isSBorBB(sid){
  const seat = state.players[sid]?.seat;
  return seat === state.table.sbSeat || seat === state.table.bbSeat;
}

function setAction(sid, type, amount){
  const p = state.players[sid]; if(!p) return;
  p.lastAction = amount!=null ? { type, amount } : { type };
  io.emit('actionInfo', { sid, type, amount }); // Broadcast für Admin & Spieler
}

function resolveWinnerAndShowdown(){
  const w = autoWinnerSid();
  if (w && sidExists(w)) {
    state.players[w].chips += state.table.pot;
  }
  state.table.pot = 0;
  // Spieler mit 0 Chips sind OUT
  for (const {sid} of seated()){
    const p = state.players[sid];
    if (p.chips <= 0) p.isOut = true;
  }
  state.round.phase = 'showdown';
  admin.emit('winner', { winnerSid: w, solution: state.round.question?.loesung });
}

function tryAutoFinishRevealBet(){
  if (state.round.phase !== 'reveal_bet') return;
  if (everyoneDone()){
    finishBettingPhase();
    resolveWinnerAndShowdown();
    broadcast();
  }
}

// ─────────────────────────────────────────────────────────────
// BOTs – simple Logik zum Testen
// ─────────────────────────────────────────────────────────────
let botInc = 1;
function addBot(nameOpt){
  const seat = state.seats.findIndex(x=>x===null);
  if (seat === -1) return null;
  const sid = 'BOT_'+Date.now()+'_'+(botInc++);
  const name = nameOpt || `Bot ${botInc}`;
  state.seats[seat] = sid;
  state.players[sid] = {
    id: sid, name, avatar: '', seat, chips: START_CHIPS, inHand: false,
    committed: 0, isOut:false, lastAction:null, isBot:true
  };
  // Autoverhalten je nach Phase
  if (state.round.phase === 'collect_guesses') {
    setTimeout(()=> botMaybeGuess(sid), 200 + Math.random()*600);
  } else {
    setTimeout(botActIfTurn, 200);
  }
  broadcast();
  return sid;
}
function removeAllBots(){
  for (const {sid, seat} of seated()){
    const p = state.players[sid];
    if (p?.isBot){
      state.seats[seat] = null;
      delete state.players[sid];
      delete state.round.guesses[sid];
      delete state.round.guessRevealed[sid];
    }
  }
  broadcast();
}
function botMaybeGuess(sid){
  if (!sidExists(sid)) return;
  if (state.round.phase !== 'collect_guesses') return;
  const v = Math.floor(Math.random()*2000);
  state.round.guesses[sid] = v;
  state.round.guessRevealed[sid] = false;
  broadcast();
  const seatsNow = seated();
  const allSubmitted = seatsNow.length>0 && seatsNow.every(({sid})=> state.round.guesses[sid]!==undefined);
  if (allSubmitted) {
    state.round.phase = 'bet1';
    newHandSetup();
    postBlinds();
    broadcast();
    setTimeout(botActIfTurn, 200);
  }
}
function botActIfTurn(){
  if (!['bet1','bet2','bet3','reveal_bet'].includes(state.round.phase)) return;
  const seat = state.table.actingSeat;
  if (seat==null) return;
  const sid = state.seats[seat];
  const p = state.players[sid];
  if (!p?.isBot || !p.inHand) return;

  const toCall = Math.max(0, state.table.currentBet - (p.committed||0));
  const r = Math.random();
  if (toCall === 0){
    if (r < 0.7) playerAction(sid, 'check');
    else playerAction(sid, 'bet', state.table.minRaise);
  } else {
    if (state.round.phase==='bet1' && isSBorBB(sid)){
      if (r < 0.8) playerAction(sid, 'call');
      else playerAction(sid, 'raise', state.table.currentBet + state.table.minRaise);
    } else if (r < 0.15) {
      playerAction(sid, 'fold');
    } else if (r < 0.8) {
      playerAction(sid, 'call');
    } else {
      playerAction(sid, 'raise', state.table.currentBet + state.table.minRaise);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Gemeinsame Action-Engine (Server ruft sie auch für Bots auf)
// ─────────────────────────────────────────────────────────────
function playerAction(sid, type, amount){
  if (!['bet1','bet2','bet3','reveal_bet'].includes(state.round.phase)) return;
  if (!sidExists(sid)) return;
  const p = state.players[sid];
  if (!p.inHand) return;
  if (state.seats[state.table.actingSeat] !== sid) return;

  const toCall = Math.max(0, state.table.currentBet - (p.committed||0));

  if (type === 'fold' && state.round.phase === 'bet1' && isSBorBB(sid)) {
    return; // SB/BB dürfen in Bet1 nicht folden
  }
  if (type === 'fold') {
    p.inHand = false;
    setAction(sid, 'fold');
    const activesLeft = active();
    if (activesLeft.length <= 1) finishBettingPhase();
    else { goNextActor(); }
    broadcast();
    if (state.round.phase === 'reveal_bet') tryAutoFinishRevealBet();
    return;
  }
  if (type === 'check') {
    if (toCall !== 0) return;
    setAction(sid, 'check');
    goNextActor();
    if (everyoneDone()) finishBettingPhase();
    broadcast();
    if (state.round.phase === 'reveal_bet') tryAutoFinishRevealBet();
    return;
  }
  if (type === 'call') {
    const pay = Math.min(p.chips, toCall);
    p.chips -= pay; p.committed = (p.committed||0) + pay; state.table.pot += pay;
    if (p.chips <= 0) p.isOut = true;
    setAction(sid, 'call', pay);
    goNextActor();
    if (everyoneDone()) finishBettingPhase();
    broadcast();
    if (state.round.phase === 'reveal_bet') tryAutoFinishRevealBet();
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
    if (p.chips <= 0) p.isOut = true;
    state.table.currentBet = Math.max(state.table.currentBet, p.committed);
    state.table.lastAggressorSeat = p.seat;
    state.table.minRaise = Math.max(state.table.minRaise, state.table.bigBlind);

    setAction(sid, 'raise', p.committed);
    goNextActor();
    broadcast();
    if (state.round.phase === 'reveal_bet') tryAutoFinishRevealBet();
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
    p.isOut = true;
    setAction(sid, 'allin', p.committed);
    goNextActor();
    broadcast();
    if (state.round.phase === 'reveal_bet') tryAutoFinishRevealBet();
    return;
  }
}

// ─────────────────────────────────────────────────────────────
// Socket.IO – Spieler (menschliche)
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', ({ name, avatar }) => {
    name = String(name||'').trim().slice(0,20) || 'Spieler';
    avatar = String(avatar||'').trim().slice(0,200);
    const seat = state.seats.findIndex(x=>x===null);
    if (seat === -1) return socket.emit('errorMsg', 'Tisch ist voll.');

    state.seats[seat] = socket.id;
    state.players[socket.id] = { id: socket.id, name, avatar, seat, chips: START_CHIPS, inHand: false, committed: 0, isOut:false, lastAction:null, isBot:false };
    socket.emit('joined', { seat });
    broadcast();
  });

  socket.on('leaveTable', () => {
    const p = state.players[socket.id];
    if (!p) return;
    state.seats[p.seat] = null;
    delete state.players[socket.id];
    delete state.round.guesses[socket.id];
    delete state.round.guessRevealed[socket.id];
    broadcast();
  });

  // Spieler-Schätzung
  socket.on('submitGuess', ({ value }) => {
    if (state.round.phase !== 'collect_guesses') return socket.emit('errorMsg', 'Schätzen ist aktuell gesperrt.');
    const num = Number(value);
    if (!Number.isFinite(num)) return socket.emit('errorMsg', 'Bitte eine gültige Zahl schätzen.');
    if (!sidExists(socket.id)) return;
    if (state.round.guesses[socket.id] !== undefined) return socket.emit('errorMsg', 'Du hast bereits geschätzt.');

    state.round.guesses[socket.id] = num;
    state.round.guessRevealed[socket.id] = false; // standard zensiert (Playersicht)
    broadcast();

    // Wenn alle sitzenden Spieler geschätzt haben → weiter zu Bet1
    const seatsNow = seated();
    const allSubmitted = seatsNow.length>0 && seatsNow.every(({sid})=> state.round.guesses[sid]!==undefined);
    if (allSubmitted) {
      state.round.phase = 'bet1';
      newHandSetup();          // setzt inHand & committed zurück
      postBlinds();            // SB/BB + erste Action
      broadcast();
      setTimeout(botActIfTurn, 200);
    }
  });

  // Spieler-Aktionen (menschlich)
  socket.on('action', ({ type, amount }) => {
    playerAction(socket.id, type, amount);
    // Evtl. ist nun ein Bot dran
    setTimeout(botActIfTurn, 200);
  });

  // Spieler können KEIN Rebuy / Chips ändern
  socket.on('rebuy', () => socket.emit('errorMsg', 'Rebuy/Chips nur durch den Admin.'));
  socket.on('adjustChips', () => socket.emit('errorMsg', 'Chips können nur vom Admin geändert werden.'));

  socket.on('disconnect', () => {
    const p = state.players[socket.id];
    if (!p) return;
    state.seats[p.seat] = null;
    delete state.players[socket.id];
    delete state.round.guesses[socket.id];
    delete state.round.guessRevealed[socket.id];
    broadcast();
  });
});

// ─────────────────────────────────────────────────────────────
// Admin-Namespace
// ─────────────────────────────────────────────────────────────
const admin = io.of('/admin');
admin.on('connection', socket => {
  socket.emit('state', publicState());
  socket.emit('admin:guesses', adminGuessesFull());

  // Runde starten → Schätzen offen
  socket.on('startRound', ({ questionId }) => {
    const q = FRAGEN.find(f => String(f.id) === String(questionId)) || FRAGEN[0];
    state.round.phase = 'collect_guesses';
    state.round.question = q;
    state.round.hintsRevealed = 0;
    state.round.guesses = {};
    state.round.guessRevealed = {};
    broadcast();
  });

  // Hinweise → Bet-Runden
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
    broadcast();
    setTimeout(botActIfTurn, 200);
  });

  // Lösung zeigen → letzte Setzrunde (reveal_bet)
  socket.on('goReveal', () => {
    state.round.phase = 'reveal';
    broadcast();
    // Start der letzten Setzrunde
    state.round.phase = 'reveal_bet';
    resetBets();
    state.table.actingSeat = nextActiveSeat(state.table.dealerSeat);
    broadcast();
    setTimeout(botActIfTurn, 200);
  });

  // Gewinner bestimmen (manuell)
  socket.on('resolveWinner', () => {
    resolveWinnerAndShowdown();
    admin.emit('sound', { key: 'correct' });
    broadcast();
  });

  // Sounds
  socket.on('playSound', ({ key }) => {
    admin.emit('sound', { key });
    io.emit('sound', { key });
  });

  // Chips/Rebuy
  socket.on('admin:adjustChips', ({ sid, delta }) => {
    const p = state.players[sid];
    if (!p) return;
    const d = Number(delta || 0);
    if (!Number.isFinite(d)) return;
    p.chips = Math.max(0, (p.chips || 0) + d);
    if (p.chips > 0) p.isOut = false;
    broadcast();
  });

  socket.on('admin:rebuy', ({ sid, amount }) => {
    const p = state.players[sid];
    if (!p) return;
    const add = Number(amount ?? START_CHIPS);
    if (!Number.isFinite(add) || add <= 0) return;
    p.chips += add;
    if (p.chips > 0) p.isOut = false;
    broadcast();
  });

  // Blinds
  socket.on('admin:setBlinds', ({ small, big }) => {
    const s = Number(small ?? state.table.smallBlind);
    const b = Number(big   ?? state.table.bigBlind);
    if (Number.isFinite(s) && s >= 1) state.table.smallBlind = s;
    if (Number.isFinite(b) && b >= s) state.table.bigBlind = b;
    broadcast();
  });

  socket.on('admin:assignBlinds', () => {
    const act = active();
    if (act.length < 2) { state.table.sbSeat = null; state.table.bbSeat = null; return broadcast(); }
    const sbSeat = nextActiveSeat(state.table.dealerSeat);
    const bbSeat = nextActiveSeat(sbSeat);
    state.table.sbSeat = sbSeat;
    state.table.bbSeat = bbSeat;
    broadcast();
  });

  // Guesses steuern
  socket.on('admin:lockGuesses', () => {
    if (state.round.phase === 'collect_guesses') {
      state.round.phase = 'bet1';
      newHandSetup();
      postBlinds();
      broadcast();
      setTimeout(botActIfTurn, 200);
    }
  });

  socket.on('admin:revealGuess', ({ sid, reveal }) => {
    if (state.round.guesses[sid] === undefined) return;
    state.round.guessRevealed[sid] = !!reveal;
    broadcast();
  });

  socket.on('admin:revealAllGuesses', ({ reveal }) => {
    for (const sid of Object.keys(state.round.guesses)) {
      state.round.guessRevealed[sid] = !!reveal;
    }
    broadcast();
  });

  // Bots
  socket.on('admin:addBot', ({ name }) => {
    addBot(name);
  });
  socket.on('admin:removeAllBots', () => {
    removeAllBots();
  });
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Listening on :' + PORT));
