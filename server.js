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

  socket.on('playerData', (data) => {
    spieler[socket.id] = { id: socket.id, ...data };
    io.emit('updateSpieler', spieler[socket.id]);
  });

  socket.on('frageStart', (frage) => {
    io.emit('frageStart', frage);
  });

  socket.on('hinweis', (num) => {
    io.emit('hinweis', num);
  });

  socket.on('aufloesung', (antwort) => {
    io.emit('aufloesung', antwort);
  });

  socket.on('disconnect', () => {
    delete spieler[socket.id];
    io.emit('updateSpieler', { id: socket.id, disconnect: true });
  });
});

server.listen(3000, () => {
  console.log('✅ Server läuft auf http://localhost:3000');
});