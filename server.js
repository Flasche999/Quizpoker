// [server.js] – QuizPoker Logik
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let fragen = [];
let globalQuestionIndex = 0;

try {
  fragen = JSON.parse(fs.readFileSync(path.join(__dirname, 'fragen.json')));
  console.log(`✅ ${fragen.length} Fragen geladen.`);
} catch (err) {
  console.error("❌ Fehler beim Laden der Fragen:", err);
}

let spieler = {};
let pot = 0;
let aktuellerEinsatz = 0;
let smallBlind = 10;
let bigBlind = 20;
let blindIndex = 0;
let spielReihenfolge = [];
let aktuellerSpielerIndex = -1;
let letzterBigBlindId = null;

function pruefeObAlleSchaetzungenAbgegeben() {
  const alleAbgegeben = Object.values(spieler).length > 0 &&
    Object.values(spieler).every(s => typeof s.antwort === 'number' && s.antwort !== "");
  if (alleAbgegeben) io.emit("alleSchaetzungenAbgegeben");
}

function setzeBlindsUndStart() {
  const spielerListe = Object.values(spieler).filter(s => s.chips > 0).sort((a, b) => a.name.localeCompare(b.name));
  if (spielerListe.length < 2) return;

  spielerListe.forEach(s => {
    s.blind = null;
    s.antwort = "";
    s.imPot = 0;
    s.aktion = "";
  });

  const small = spielerListe[blindIndex % spielerListe.length];
  const big = spielerListe[(blindIndex + 1) % spielerListe.length];

  small.blind = 'small';
  big.blind = 'big';
  letzterBigBlindId = big.id;

  [small, big].forEach((s, i) => {
    const blind = i === 0 ? smallBlind : bigBlind;
    if (s.chips <= blind) {
      pot += s.chips;
      s.imPot += s.chips;
      s.chips = 0;
      s.aktion = "All In";
    } else {
      s.chips -= blind;
      s.imPot += blind;
      pot += blind;
    }
  });

  aktuellerEinsatz = Math.max(small.imPot, big.imPot);
  spielerListe.forEach(s => io.emit("updateSpieler", s));
  io.emit("updateAlleSpieler", spielerListe);
  io.emit("potAktualisiert", pot);
  io.emit("blindsMarkieren", { small: small.name, big: big.name });

  const indexBB = spielerListe.findIndex(s => s.id === big.id);
  const vorne = spielerListe.slice(indexBB + 1);
  const hinten = spielerListe.slice(0, indexBB);
  const richtigeReihenfolge = vorne.concat(hinten).filter(s => s.chips > 0);

  spielReihenfolge = richtigeReihenfolge.map(s => s.id);
  aktuellerSpielerIndex = 0;

  const erster = spielReihenfolge[0];
  if (erster) io.to(erster).emit("aktionErlaubt", { aktuellerEinsatz, pot });

  blindIndex++;
}

function starteSetzrunde() {
  Object.values(spieler).forEach(s => {
    if (s.aktion !== "Fold" && s.chips > 0) s.aktion = "";
    io.emit("updateSpieler", s);
  });

  const aktiveSpieler = Object.values(spieler).filter(s => s.aktion !== "Fold" && s.chips > 0);
  spielReihenfolge = aktiveSpieler.map(s => s.id);

  if (letzterBigBlindId) {
    const indexBB = spielReihenfolge.indexOf(letzterBigBlindId);
    if (indexBB !== -1) {
      const vorne = spielReihenfolge.slice(indexBB + 1);
      const hinten = spielReihenfolge.slice(0, indexBB + 1);
      spielReihenfolge = vorne.concat(hinten);
    }
  }

  aktuellerSpielerIndex = 0;
  const erster = spielReihenfolge[0];
  if (erster) io.to(erster).emit("aktionErlaubt", { aktuellerEinsatz, pot });
}

io.on('connection', (socket) => {
  console.log('🔌 Spieler verbunden:', socket.id);

  socket.on("playerData", (data) => {
    if (!data || typeof data.name !== "string" || typeof data.avatar !== "string") return;

    spieler[socket.id] = {
      id: socket.id,
      name: data.name,
      avatar: data.avatar,
      chips: data.chips || 1000,
      antwort: "",
      aktion: "",
      imPot: 0,
      blind: null
    };

    io.emit("updateSpieler", spieler[socket.id]);
    io.emit("updateAlleSpieler", Object.values(spieler));
  });

  socket.on("schaetzAntwort", (wert) => {
    const s = spieler[socket.id];
    if (!s || s.aktion === "Fold") return;
    s.antwort = wert;
    io.emit("zeigeSchaetzAntwortAdmin", { name: s.name, wert, id: socket.id });
    socket.broadcast.emit("zeigeSchaetzAntwortVerdeckt", { name: s.name });
    pruefeObAlleSchaetzungenAbgegeben();
  });

  socket.on("zeigeHinweis", (num) => {
    const frage = fragen[globalQuestionIndex - 1];
    if (!frage) return;

    const text = num === 1 ? frage.hinweis1 : frage.hinweis2;
    io.emit("hinweis", { num, text });

    setTimeout(() => {
      starteSetzrunde();
    }, 500);
  });

  socket.on("zeigeAufloesung", () => {
    const frage = fragen[globalQuestionIndex - 1];
    if (!frage) return;

    const antwort = Number(frage.antwort);
    if (isNaN(antwort)) return;

    io.emit("aufloesung", antwort);

    const gültigeSpieler = Object.values(spieler).filter(s => typeof s.antwort === 'number');
    if (gültigeSpieler.length > 0) {
      let nächster = gültigeSpieler[0];
      let diff = Math.abs(nächster.antwort - antwort);
      gültigeSpieler.forEach(s => {
        const abw = Math.abs(s.antwort - antwort);
        if (abw < diff) {
          nächster = s;
          diff = abw;
        }
      });
      io.emit("schaetzSieger", nächster.name);
    }

    setTimeout(() => {
      starteSetzrunde();
    }, 500);
  });

  socket.on("spielerAktion", ({ aktion, raiseBetrag }) => {
    const s = spieler[socket.id];
    if (!s) return;

    if (s.chips <= 0 && s.aktion !== "All In") {
      s.aktion = "Ausgeschieden";
      io.emit("updateSpieler", s);
      return;
    }

    if (aktion === "fold") s.aktion = "Fold";

    if (aktion === "call") {
      const toCall = aktuellerEinsatz - (s.imPot || 0);
      const callBetrag = Math.min(toCall, s.chips);
      s.chips -= callBetrag;
      s.imPot += callBetrag;
      pot += callBetrag;
      s.aktion = s.chips === 0 ? "All In" : "Call";
    }

    if (aktion === "raise") {
      const betrag = parseInt(raiseBetrag);
      if (betrag >= s.chips) {
        aktuellerEinsatz = s.chips;
        pot += s.chips;
        s.imPot += s.chips;
        s.aktion = "All In";
        s.chips = 0;
      } else {
        aktuellerEinsatz = betrag;
        s.chips -= betrag;
        s.imPot += betrag;
        pot += betrag;
        s.aktion = "Raise";
      }
    }

    if (aktion === "allin") {
      pot += s.chips;
      s.imPot += s.chips;
      s.aktion = "All In";
      s.chips = 0;
    }

    io.emit("spielerAktion", {
      name: s.name,
      action: s.aktion,
      bet: s.imPot || 0
    });

    io.emit("updateSpieler", s);
    io.emit("updateAlleSpieler", Object.values(spieler));
    io.emit("potAktualisiert", pot);

    aktuellerSpielerIndex++;
    if (aktuellerSpielerIndex < spielReihenfolge.length) {
      const nextID = spielReihenfolge[aktuellerSpielerIndex];
      io.to(nextID).emit("aktionErlaubt", { aktuellerEinsatz, pot });
    }
  });

  socket.on("frageStart", () => {
    if (globalQuestionIndex >= fragen.length) {
      io.emit("frageStart", { frage: "🎉 Keine Fragen mehr!" });
      return;
    }

    const frage = fragen[globalQuestionIndex];
    io.emit("frageStart", {
      frage: frage.frage,
      nummer: globalQuestionIndex + 1,
      gesamt: fragen.length
    });

    globalQuestionIndex++;
    setzeBlindsUndStart();
  });

  socket.on('disconnect', () => {
    delete spieler[socket.id];
    io.emit('updateSpieler', { id: socket.id, disconnect: true });
    io.emit('updateAlleSpieler', Object.values(spieler));
  });
});

server.listen(3000, () => {
  console.log("✅ Server läuft auf http://localhost:3000");
});
