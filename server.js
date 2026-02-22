const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

const rooms = {};

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  Object.values(room.players).forEach(p => {
    send(p.ws, data);
  });
}

function createBall() {
  return {
    x: 0.5,
    y: 0.5,
    vx: 0,
    vy: 0,
    r: 0.03
  };
}

function mkPlayer(id, ws, name, team) {
  return {
    id,
    ws,
    name,
    team,
    x: team === 0 ? 0.3 : 0.7,
    y: 0.5,
    vx: 0,
    vy: 0,
    boost: 1,
    input: {},
  };
}

function tickRoom(room) {
  if (!room.started || room._gameOverSent) return;

  const dt = 1 / 60;
  room.timeLeft = Math.max(0, room.timeLeft - dt);

  if (room.timeLeft === 0) {
    room._gameOverSent = true;
    room.started = false;
    clearInterval(room.ticker);
    broadcast(room, {
      type: 'GAME_OVER',
      scoreA: room.scoreA,
      scoreB: room.scoreB
    });
    return;
  }

  Object.values(room.players).forEach(p => {
    const inp = p.input || {};

    const ACCEL = 2.8;
    const maxSpeed = inp.boost ? 0.45 : 0.30;

    let ax = 0, ay = 0;
    if (inp.up) ay -= 1;
    if (inp.down) ay += 1;
    if (inp.left) ax -= 1;
    if (inp.right) ax += 1;

    const len = Math.sqrt(ax * ax + ay * ay) || 1;

    p.vx += (ax / len) * ACCEL * dt;
    p.vy += (ay / len) * ACCEL * dt;

    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp > maxSpeed) {
      p.vx = (p.vx / sp) * maxSpeed;
      p.vy = (p.vy / sp) * maxSpeed;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
  });

  broadcast(room, {
    type: 'GAME_STATE',
    timestamp: Date.now(),
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      boost: p.boost
    })),
    ball: room.ball,
    scoreA: room.scoreA,
    scoreB: room.scoreB,
    timeLeft: room.timeLeft
  });
}

wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'PING') {
      send(ws, {
        type: 'PONG',
        clientTime: msg.clientTime,
        serverTime: Date.now()
      });
      return;
    }

    if (msg.type === 'CREATE_SERVER') {
      const id = Math.random().toString(36).slice(2,8).toUpperCase();
      rooms[id] = {
        id,
        players: {},
        ball: createBall(),
        scoreA: 0,
        scoreB: 0,
        timeLeft: msg.time || 180,
        started: false
      };

      rooms[id].players[playerId] =
        mkPlayer(playerId, ws, msg.name, 0);

      roomId = id;

      send(ws, {
        type: 'SERVER_CREATED',
        serverId: id,
        playerId
      });
    }

    if (msg.type === 'JOIN_SERVER') {
      const room = rooms[msg.serverId];
      if (!room) return;

      const team =
        Object.keys(room.players).length % 2;

      room.players[playerId] =
        mkPlayer(playerId, ws, msg.name, team);

      roomId = msg.serverId;

      send(ws, {
        type: 'JOINED',
        playerId,
        team
      });
    }

    if (msg.type === 'LAUNCH') {
      const room = rooms[roomId];
      if (!room) return;

      room.started = true;
      room._gameOverSent = false;
      room.ticker = setInterval(
        () => tickRoom(room),
        TICK_MS
      );
    }

    if (msg.type === 'INPUT') {
      const room = rooms[roomId];
      if (!room) return;
      const p = room.players[playerId];
      if (!p) return;
      p.input = msg.input;
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    delete room.players[playerId];
  });
});

server.listen(3000, () =>
  console.log("Server running on 3000")
);
