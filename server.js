const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let spieler = {};
let aktuellerEinsatz = 0;

// 🔁 NEU: Reihenfolge für Aktionsphase
let spielReihenfolge = [];
let aktuellerSpielerIndex = -1;

// Hilfsfunktion: prüfen, ob alle Schätzungen da sind
function prüfeObAlleGesendetHaben() {
  const alleFertig = Object.values(spieler).length > 0 && Object.values(spieler).every(s => s.antwort !== "");
  if (alleFertig) {
    // Reihenfolge festlegen
    spielReihenfolge = Object.values(spieler).map(s => s.id);
    aktuellerSpielerIndex = 0;

    const erster = spielReihenfolge[0];
    if (erster) {
      io.to(erster).emit("aktionErlaubt");
    }
  }
}

io.on('connection', (socket) => {
  console.log('🔌 Spieler verbunden:', socket.id);

  // Spieler sendet seine Daten
  socket.on('playerData', (data) => {
    spieler[socket.id] = { id: socket.id, ...data };

    // Einzelnes Update an alle Spieler
    io.emit('updateSpieler', spieler[socket.id]);

    // Zusätzlich: Broadcast an alle mit Name, Aktion und Chips (für Spielerübersicht)
    io.emit('playerData', {
      name: data.name,
      aktion: data.aktion,
      chips: data.chips
    });

    // Nach Abgabe prüfen ob alle fertig
    prüfeObAlleGesendetHaben();
  });

  // Spieler ist mit Aktion fertig
  socket.on("spielerAktionFertig", () => {
    aktuellerSpielerIndex++;
    if (aktuellerSpielerIndex < spielReihenfolge.length) {
      const naechster = spielReihenfolge[aktuellerSpielerIndex];
      io.to(naechster).emit("aktionErlaubt");
    } else {
      console.log("✅ Alle Spieler haben ihre Aktion gewählt.");
    }
  });

  // Admin startet eine neue Frage
  socket.on('frageStart', (frage) => {
    io.emit('frageStart', frage);

    // Aktionen aller Spieler zurücksetzen
    Object.values(spieler).forEach((s) => {
      s.aktion = "";
      s.antwort = "";
      io.emit("playerData", {
        name: s.name,
        aktion: "",
        chips: s.chips
      });
    });

    // Reihenfolge zurücksetzen
    spielReihenfolge = [];
    aktuellerSpielerIndex = -1;
  });

  // Admin zeigt Hinweis an (jetzt mit Text)
  socket.on('hinweis', ({ num, text }) => {
    console.log(`📢 Hinweis ${num}: ${text}`);
    io.emit('hinweis', { num, text });
  });

  // Admin zeigt Auflösung an
  socket.on('aufloesung', (antwort) => {
    io.emit('aufloesung', antwort);
  });

  // Admin setzt Chips für alle Spieler
  socket.on('setAllChips', (betrag) => {
    console.log(`💰 Admin setzt bei allen Spielern die Chips auf ${betrag}`);
    Object.values(spieler).forEach((s) => {
      s.chips = betrag;
    });

    // ❗ Chips-Update an alle Clients inkl. Admin
    Object.values(spieler).forEach((s) => {
      io.emit("updateSpieler", s);
    });
  });

  // Admin setzt den aktuellen Einsatz für die Runde
  socket.on('setEinsatz', (betrag) => {
    aktuellerEinsatz = betrag;
    console.log(`🎯 Aktueller Einsatz: ${betrag} Chips`);
    io.emit("einsatzAktualisiert", aktuellerEinsatz);
  });

  // Spieler verlässt das Spiel
  socket.on('disconnect', () => {
    delete spieler[socket.id];
    io.emit('updateSpieler', { id: socket.id, disconnect: true });
  });
});

server.listen(3000, () => {
  console.log('✅ Server läuft auf http://localhost:3000');
});
