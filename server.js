const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const fs = require('fs');
const path = require('path');

let fragen = [];
let globalQuestionIndex = 0;

try {
  fragen = JSON.parse(fs.readFileSync(path.join(__dirname, 'fragen.json')));
  console.log(`✅ ${fragen.length} Fragen geladen.`);
} catch (err) {
  console.error("❌ Fehler beim Laden der Fragen:", err);
}


app.use(express.static(__dirname));

let spieler = {};
let pot = 0;
let aktuellerEinsatz = 0;
let smallBlind = 200;
let bigBlind = 250;
let blindIndex = 0;
let spielReihenfolge = [];
let aktuellerSpielerIndex = -1;
let letzterBigBlindId = null;

function setzeBlindsUndStart() {
  const spielerListe = Object.values(spieler)
  .filter(s => s.chips > 0)
  .sort((a, b) => a.name.localeCompare(b.name)); // feste Reihenfolge nach Namen
  if (spielerListe.length < 2) return;

  // Reset
  spielerListe.forEach(s => {
    s.blind = null;
    s.antwort = "";
    s.imPot = 0;
    s.aktion = "";
  });

  const small = spielerListe[blindIndex % spielerListe.length];
  const big = spielerListe[(blindIndex + 1) % spielerListe.length];

  // Small Blind zahlen
  if (small.chips <= smallBlind) {
    pot += small.chips;
    small.imPot = (small.imPot || 0) + small.chips;
    small.chips = 0;
    small.aktion = "All In";
  } else {
    small.chips -= smallBlind;
    small.imPot = (small.imPot || 0) + smallBlind;
    pot += smallBlind;
  }

  // Big Blind zahlen
  if (big.chips <= bigBlind) {
    pot += big.chips;
    big.imPot = (big.imPot || 0) + big.chips;
    big.chips = 0;
    big.aktion = "All In";
  } else {
    big.chips -= bigBlind;
    big.imPot = (big.imPot || 0) + bigBlind;
    pot += bigBlind;
  }

  small.blind = 'small';
  big.blind = 'big';
  letzterBigBlindId = big.id;

  aktuellerEinsatz = Math.max(small.imPot, big.imPot);

  // Update Spieler-UI
spielerListe.forEach(s => {
  io.emit("updateSpieler", s);
});
io.emit("updateAlleSpieler", spielerListe); // ✅ nur EINMAL nach der Schleife


  io.emit("potAktualisiert", pot);
  io.emit("blindsMarkieren", {
    small: small.name,
    big: big.name
  });

  // 👉 Spielreihenfolge: Start beim Spieler nach dem Big Blind
  const indexBB = spielerListe.findIndex(s => s.id === big.id);
  const vorne = spielerListe.slice(indexBB + 1);
  const hinten = spielerListe.slice(0, indexBB); // 👈 ohne den Big Blind selbst
  const richtigeReihenfolge = vorne.concat(hinten).filter(s => s.chips > 0);

  spielReihenfolge = richtigeReihenfolge.map(s => s.id);
  aktuellerSpielerIndex = 0;

  const erster = spielReihenfolge[0];
  if (erster) {
    io.to(erster).emit("aktionErlaubt", { aktuellerEinsatz, pot });
  }

  blindIndex++;
}


function sindAlleAntwortenAbgegeben() {
  const aktiveSpieler = Object.values(spieler).filter(s => s.aktion !== "Fold" && s.chips > 0);
  return aktiveSpieler.every(s => typeof s.antwort === "number");
}

function starteSetzrunde() {
  Object.values(spieler).forEach(s => {
    if (s.aktion !== "Fold" && s.chips > 0) {
      s.aktion = "";
      io.emit("updateSpieler", s);
    }
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
  if (erster && typeof spieler[erster]?.antwort === "number") {
    io.to(erster).emit("aktionErlaubt", { aktuellerEinsatz, pot });
  } else {
    console.log("⛔ Spieler darf noch nicht setzen – Antwort fehlt:", spieler[erster]?.name);
  }
} // ✅ Diese Klammer war bei dir **nicht vorhanden**!


// Jetzt ist das gültig:
io.on('connection', (socket) => {
  console.log('🔌 Spieler verbunden:', socket.id);


  // ✅ Hier direkt einfügen:
  socket.on('naechsteFrage', () => {
    sendeNaechsteFrage();
  });

  socket.on("zeigeHinweis", (num) => {
  const aktuelleFrage = fragen[globalQuestionIndex - 1]; // aktuelle Frage holen
  if (!aktuelleFrage) return;

  const text = num === 1 ? aktuelleFrage.hinweis1 : aktuelleFrage.hinweis2;
  io.emit("hinweis", { num, text });

  if (num === 1 || num === 2) {
    setTimeout(() => starteSetzrunde(), 500); // 1. oder 2. Setzrunde starten
  }
});

socket.on("zeigeAufloesung", () => {
  const aktuelleFrage = fragen[globalQuestionIndex - 1];
  if (!aktuelleFrage) return;

  const antwort = Number(aktuelleFrage.antwort);
  if (isNaN(antwort)) {
    console.warn("❌ Antwort konnte nicht gelesen werden:", aktuelleFrage.antwort);
    io.emit("aufloesung", "Keine gültige Antwort.");
    return;
  }

  io.emit("aufloesung", antwort);

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

  setTimeout(() => starteSetzrunde(), 500); // Letzte Setzrunde starten
});


socket.on("playerData", (data) => {
  if (
    !data ||
    typeof data.name !== "string" ||
    data.name.trim() === "" ||
    typeof data.avatar !== "string" ||
    data.avatar.trim() === ""
  ) {
    console.warn("⛔ Ungültiger Spieler abgewiesen:", data);
    return;
  }



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
  if (!s) return;

  // Spieler, die „Fold“ oder „Ausgeschieden“ sind, dürfen NICHT tippen
  if (s.aktion === "Fold" || s.aktion === "Ausgeschieden") return;

  s.antwort = wert;

  io.emit("zeigeSchaetzAntwortAdmin", { name: s.name, wert, id: socket.id });
  socket.broadcast.emit("zeigeSchaetzAntwortVerdeckt", { name: s.name });

  if (sindAlleAntwortenAbgegeben()) {
    io.emit("alleAntwortenAbgegeben"); // Optional für UI-Freigabe
  }
});


  socket.on("adminVergibtPot", (gewinnerID) => {
    const s = spieler[gewinnerID];
    if (s) {
      s.chips += pot;
      io.emit("updateSpieler", s);
      io.emit("potAktualisiert", 0);
      pot = 0;
    }
  });

socket.on('spielerAktion', ({ aktion, raiseBetrag }) => {
  const s = spieler[socket.id];
  if (!s) return;

  if (s.chips <= 0 && s.aktion !== "All In") {
    if (!s.imPot || s.imPot === 0) {
      s.aktion = "Ausgeschieden";
      io.emit("updateSpieler", s);
      return;
    }
  }

  if (aktion === "fold") {
    s.aktion = "Fold";
  }

  if (aktion === "call") {
    const toCall = aktuellerEinsatz - (s.imPot || 0);
    const callBetrag = Math.min(toCall, s.chips);
    s.imPot = (s.imPot || 0) + callBetrag;
    pot += callBetrag;
    s.chips -= callBetrag;

    s.aktion = (s.chips === 0) ? "All In" : "Call";
  }

  if (aktion === "raise") {
    const raiseGesamt = parseInt(raiseBetrag);
    if (raiseGesamt >= s.chips) {
      aktuellerEinsatz = s.chips;
      pot += s.chips;
      s.imPot = (s.imPot || 0) + s.chips;
      s.aktion = "All In";
      s.chips = 0;
    } else {
      aktuellerEinsatz = raiseGesamt;
      s.chips -= raiseGesamt;
      s.imPot = (s.imPot || 0) + raiseGesamt;
      pot += raiseGesamt;
      s.aktion = "Raise";
    }
  }

  if (aktion === "allin") {
    pot += s.chips;
    s.aktion = "All In";
    s.imPot = (s.imPot || 0) + s.chips;
    s.chips = 0;
  }

  // ✅ NEU: Aktion an alle Spieler senden
  io.emit("spielerAktion", {
    name: s.name,
    action: s.aktion === "Raise" ? `Raise ${raiseBetrag}` : s.aktion,
    bet: s.imPot || 0
  });

  io.emit("updateAlleSpieler", Object.values(spieler)); // ✅ damit neue Chips/Pots auch übertragen werden


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
  io.emit("updateSpieler", s);
});

 

    spielReihenfolge = [];
    aktuellerSpielerIndex = -1;
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

  socket.on("setBlinds", ({ small, big }) => {
  smallBlind = small;
  bigBlind = big;

  const aktiveSpieler = Object.values(spieler).filter(s => s.chips > 0);
  if (aktiveSpieler.length < 2) return;

  // Reset blinds vorher
  aktiveSpieler.forEach(s => s.blind = null);

  const smallSpieler = aktiveSpieler[blindIndex % aktiveSpieler.length];
  const bigSpieler = aktiveSpieler[(blindIndex + 1) % aktiveSpieler.length];

  smallSpieler.chips -= smallBlind;
  bigSpieler.chips -= bigBlind;

  smallSpieler.imPot = smallBlind;
  bigSpieler.imPot = bigBlind;

  smallSpieler.blind = 'small';
  bigSpieler.blind = 'big';

  aktuellerEinsatz = bigBlind;
  pot = smallBlind + bigBlind;

  // 👉 Broadcast an alle Clients
  io.emit("updateSpieler", smallSpieler);
  io.emit("updateSpieler", bigSpieler);

  // 👉 Markierung für Spieler-HTML
  io.emit("blindsMarkieren", {
    small: smallSpieler.name,
    big: bigSpieler.name
  });

  blindIndex++; // für nächste Runde vorbereiten
});


  socket.on('potAuszahlen', (gewinnerListe) => {
    verteilePot(gewinnerListe);
  });

  
  socket.on("gewinnerAnimation", () => {
    const nochDrin = Object.values(spieler).filter(s => s.chips > 0);
    if (nochDrin.length === 1) {
      const gewinnerID = nochDrin[0].id;
      io.to(gewinnerID).emit("starteGewinnerAnimation");
    }
  });

  socket.on('disconnect', () => {
    delete spieler[socket.id];
    io.emit('updateSpieler', { id: socket.id, disconnect: true });
    io.emit('updateAlleSpieler', Object.values(spieler));

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
  io.emit("updateAlleSpieler", Object.values(spieler)); // ✅ Chips-Update für alle

}

function sendeNaechsteFrage() {
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

  // 👉 Neue Blinds setzen + Startspieler definieren
  setzeBlindsUndStart(); // ✅ DAS IST DER KERN

  // 👉 Spielerwerte zurücksetzen
  Object.values(spieler).forEach(s => {
    s.antwort = "";
    s.aktion = "";
    s.imPot = 0;
    io.emit("updateSpieler", s); // Einzelnes Update
  });

  // 👉 ALLE Spielerinfos senden (z. B. Chips & Potanzeige aktualisieren)
  io.emit("updateAlleSpieler", Object.values(spieler)); // ✅ HIER GENAU!
}




server.listen(3000, () => {
  console.log('✅ Server läuft auf http://localhost:3000');
});
