const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let spieler = {};
let pot = 0;
let aktuellerEinsatz = 0;
let smallBlind = 10;
let bigBlind = 20;
let blindIndex = 0;
let spielReihenfolge = [];
let aktuellerSpielerIndex = -1;
let letzterBigBlindId = null; // 👈 Neu: Big Blind merken

function setzeBlindsUndStart() {
  const spielerListe = Object.values(spieler);
  if (spielerListe.length < 2) return;

  spielerListe.forEach(s => s.blind = null);

  const small = spielerListe[blindIndex % spielerListe.length];
  const big = spielerListe[(blindIndex + 1) % spielerListe.length];

  small.chips -= smallBlind;
  big.chips -= bigBlind;

  small.imPot = smallBlind;
  big.imPot = bigBlind;

  small.blind = 'small';
  big.blind = 'big';
  letzterBigBlindId = big.id; // 👈 merken

  aktuellerEinsatz = bigBlind;
  pot = smallBlind + bigBlind;

  spielerListe.forEach(s => {
    io.emit("updateSpieler", s);
  });

  io.emit("potAktualisiert", pot);
  io.emit("blindsMarkieren", {
    small: small.name,
    big: big.name
  });

  blindIndex++;
}

function prüfeObAlleGesendetHaben() {
  const alleFertig = Object.values(spieler).length > 0 && Object.values(spieler).every(s => s.antwort !== "");
  if (alleFertig) {
    const aktuelleReihenfolge = Object.values(spieler).map(s => s.id);
    if (spielReihenfolge.length > 0) {
      const letzterStart = spielReihenfolge[0];
      const index = aktuelleReihenfolge.indexOf(letzterStart);
      if (index !== -1) {
        const vorne = aktuelleReihenfolge.slice(index + 1);
        const hinten = aktuelleReihenfolge.slice(0, index + 1);
        spielReihenfolge = vorne.concat(hinten);
      } else {
        spielReihenfolge = aktuelleReihenfolge;
      }
    } else {
      spielReihenfolge = aktuelleReihenfolge;
    }

    aktuellerSpielerIndex = 0;
    const erster = spielReihenfolge[0];
    if (erster) {
      io.to(erster).emit("aktionErlaubt", { aktuellerEinsatz, pot });
    }
  }
}

function starteSetzrunde() {
  Object.values(spieler).forEach(s => {
    if (s.aktion !== "Fold") {
      s.aktion = "";
      io.emit("updateSpieler", s);
    }
  });

  const aktiveSpieler = Object.values(spieler).filter(s => s.aktion !== "Fold");
  spielReihenfolge = aktiveSpieler.map(s => s.id);

  // 👇 Spieler direkt nach dem Big Blind beginnt
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
  if (erster) {
    io.to(erster).emit("aktionErlaubt", { aktuellerEinsatz, pot });
  }
}

io.on('connection', (socket) => {
  console.log('🔌 Spieler verbunden:', socket.id);

  socket.on('playerData', (data) => {
    if (!spieler[socket.id]) {
      spieler[socket.id] = { id: socket.id, imPot: 0 };
    }

    spieler[socket.id] = {
      ...spieler[socket.id],
      ...data
    };

    io.emit('updateSpieler', spieler[socket.id]);
    io.emit('playerData', {
      name: data.name,
      aktion: data.aktion,
      chips: data.chips
    });

    io.emit('updateAlleSpieler', spieler);
    prüfeObAlleGesendetHaben();
  });

  socket.on("schaetzAntwort", (wert) => {
    const s = spieler[socket.id];
    if (s) {
      s.antwort = wert;

      io.emit("zeigeSchaetzAntwortAdmin", { name: s.name, wert });
      socket.broadcast.emit("zeigeSchaetzAntwortVerdeckt", { name: s.name });
    }
  });

  socket.on('spielerAktion', ({ aktion, raiseBetrag }) => {
    const s = spieler[socket.id];
    if (!s || s.chips <= 0) return;

    if (aktion === "fold") {
      s.aktion = "Fold";
    }

    if (aktion === "call") {
      const toCall = aktuellerEinsatz - (s.imPot || 0);
      const callBetrag = Math.min(toCall, s.chips);
      s.chips -= callBetrag;
      s.imPot = (s.imPot || 0) + callBetrag;
      pot += callBetrag;
      s.aktion = "Call";
    }

    if (aktion === "raise") {
      const raiseGesamt = parseInt(raiseBetrag);
      if (raiseGesamt > s.chips) return;

      aktuellerEinsatz = raiseGesamt;
      s.chips -= raiseGesamt;
      s.imPot = (s.imPot || 0) + raiseGesamt;
      pot += raiseGesamt;
      s.aktion = "Raise";
    }

    if (aktion === "allin") {
      pot += s.chips;
      s.aktion = "All In";
      s.imPot = (s.imPot || 0) + s.chips;
      s.chips = 0;
    }

    io.emit("updateSpieler", s);
    io.emit("potAktualisiert", pot);

    aktuellerSpielerIndex++;
    if (aktuellerSpielerIndex < spielReihenfolge.length) {
      const nextID = spielReihenfolge[aktuellerSpielerIndex];
      io.to(nextID).emit("aktionErlaubt", { aktuellerEinsatz, pot });
    } else {
      console.log("✅ Alle Spieler haben gesetzt.");
    }
  });

  socket.on('frageStart', (frage) => {
    io.emit('frageStart', frage);

    Object.values(spieler).forEach(s => {
      s.aktion = "";
      s.antwort = "";
      s.imPot = 0;
      io.emit("playerData", {
        name: s.name,
        aktion: "",
        chips: s.chips
      });
    });

    spielReihenfolge = [];
    aktuellerSpielerIndex = -1;
    setzeBlindsUndStart();
  });

  socket.on('hinweis', ({ num, text }) => {
    console.log(`📢 Hinweis ${num}: ${text}`);
    io.emit('hinweis', { num, text });

    setTimeout(() => {
      starteSetzrunde();
    }, 500);
  });

  socket.on('aufloesung', (antwort) => {
    io.emit('aufloesung', antwort);

    const gültigeSpieler = Object.values(spieler).filter(s => typeof s.antwort === 'number');
    if (gültigeSpieler.length > 0) {
      let nächster = gültigeSpieler[0];
      let diff = Math.abs(nächster.antwort - antwort);

      gültigeSpieler.forEach(s => {
        const abweichung = Math.abs(s.antwort - antwort);
        if (abweichung < diff) {
          nächster = s;
          diff = abweichung;
        }
      });

      io.emit("schaetzSieger", nächster.name);
    }

    setTimeout(() => {
      starteSetzrunde();
    }, 500);
  });

  socket.on('setAllChips', (betrag) => {
    Object.values(spieler).forEach(s => {
      s.chips = betrag;
      s.imPot = 0;
    });

    Object.values(spieler).forEach(s => {
      io.emit("updateSpieler", s);
    });
  });

  socket.on('setEinsatz', (betrag) => {
    aktuellerEinsatz = betrag;
    io.emit("einsatzAktualisiert", aktuellerEinsatz);
  });

  socket.on('setBlinds', ({ small, big }) => {
    smallBlind = small;
    bigBlind = big;
    console.log(`⚙️ Neue Blinds gesetzt: Small = ${small}, Big = ${big}`);
  });

  socket.on('potAuszahlen', (gewinnerListe) => {
    verteilePot(gewinnerListe);
  });

  socket.on('disconnect', () => {
    delete spieler[socket.id];
    io.emit('updateSpieler', { id: socket.id, disconnect: true });
    io.emit('updateAlleSpieler', spieler);
  });
});

function verteilePot(gewinnerNamen) {
  if (gewinnerNamen.length === 0) return;

  const anteil = Math.floor(pot / gewinnerNamen.length);
  const rest = pot % gewinnerNamen.length;

  gewinnerNamen.forEach((name, index) => {
    const spielerObj = Object.values(spieler).find(s => s.name === name);
    if (spielerObj) {
      spielerObj.chips += anteil + (index < rest ? 1 : 0);
      io.emit("updateSpieler", spielerObj);
    }
  });

  pot = 0;
  io.emit("potAktualisiert", pot);
}

server.listen(3000, () => {
  console.log('✅ Server läuft auf http://localhost:3000');
});
