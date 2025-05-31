const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let spieler = {};

io.on('connection', (socket) => {
  console.log('🔌 Spieler verbunden:', socket.id);

  // Spieler sendet seine Daten (Name, Antwort, Aktion, Chips)
  socket.on('playerData', (data) => {
    spieler[socket.id] = { id: socket.id, ...data };
    io.emit('updateSpieler', spieler[socket.id]);
  });

  // Admin startet eine neue Frage
  socket.on('frageStart', (frage) => {
    io.emit('frageStart', frage);
  });

  // Admin zeigt Hinweis an
  socket.on('hinweis', (num) => {
    io.emit('hinweis', num);
  });

  // Admin zeigt Auflösung an
  socket.on('aufloesung', (antwort) => {
    io.emit('aufloesung', antwort);
  });

  // Admin setzt einen Betrag für ALLE Spieler
  socket.on('setAllChips', (betrag) => {
    console.log(`💰 Admin setzt bei allen Spielern die Chips auf ${betrag}`);
    Object.values(spieler).forEach((s) => {
      s.chips = betrag;
      io.to(s.id).emit("updateSpieler", s);
    });
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
