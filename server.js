const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======= CONSTANTES PHYSIQUE (normalisées 0-1 sur le terrain) =======
// Le terrain est 1.0 x 1.0 en coordonnées normalisées
// GW = largeur cage, GH = hauteur cage (en fraction du terrain)
const FIELD = { W: 1.0, H: 1.0 };
const GOAL_W = 0.065;
const GOAL_H = 0.30;
const BALL_R = 0.032; // rayon balle (fraction de min(W,H))
const CAR_W = 0.10;
const CAR_H = 0.065;
const SPD = 0.22;       // vitesse joueur par seconde
const FRIC = 0.87;
const BNC = 0.62;
const TICK = 1000 / 60; // 60 ticks/sec

const rooms = {};

// ======= PHYSIQUE SERVEUR =======
function createBall() {
  return {
    x: 0.5, y: 0.5,
    vx: (Math.random() - 0.5) * 0.07,
    vy: (Math.random() - 0.5) * 0.07,
    r: BALL_R
  };
}

function resetBall(room) {
  room.ball = createBall();
}

function resetPlayerPositions(room) {
  const pids = Object.keys(room.players);
  pids.forEach((pid, i) => {
    const p = room.players[pid];
    p.x = p.team === 0 ? 0.22 : 0.78;
    p.y = 0.5;
    p.vx = 0;
    p.vy = 0;
    p.angle = p.team === 1 ? Math.PI : 0;
  });
}

function ballCollide(car, ball) {
  const dx = ball.x - car.x, dy = ball.y - car.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const md = ball.r + Math.max(CAR_W, CAR_H) * 0.46;
  if (dist < md) {
    const nx = dx / dist, ny = dy / dist;
    const cvx = (car.vx || 0) / 60, cvy = (car.vy || 0) / 60;
    const rvx = ball.vx - cvx, rvy = ball.vy - cvy;
    const dot = rvx * nx + rvy * ny;
    if (dot < 0) {
      const cs = Math.sqrt(cvx * cvx + cvy * cvy);
      const imp = -dot * 1.65 + cs * 0.45 + 0.022;
      ball.vx += nx * imp;
      ball.vy += ny * imp;
    }
    ball.x = car.x + nx * (md + 0.005);
    ball.y = car.y + ny * (md + 0.005);
  }
}

function tickRoom(room) {
  if (!room.started || room.paused) return;
  const dt = TICK / 1000;

  // Timer
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) {
    room.timeLeft = 0;
    room.started = false;
    broadcast(room, {
      type: 'GAME_OVER',
      scoreA: room.scoreA,
      scoreB: room.scoreB
    });
    clearInterval(room.ticker);
    return;
  }

  // Joueurs: appliquer inputs → physique
  Object.values(room.players).forEach(p => {
    const inp = p.input || {};
    const boosting = inp.boost && p.boost > 0;
    const spd = SPD * (boosting ? 1.88 : 1);
    if (boosting) p.boost = Math.max(0, p.boost - dt * 0.55);
    else p.boost = Math.min(1, p.boost + dt * 0.18);

    let ax = 0, ay = 0;
    if (inp.up)    ay -= 1;
    if (inp.down)  ay += 1;
    if (inp.left)  ax -= 1;
    if (inp.right) ax += 1;
    const al = Math.sqrt(ax * ax + ay * ay) || 1;
    p.vx += (ax / al) * spd * dt * 3.2;
    p.vy += (ay / al) * spd * dt * 3.2;
    p.vx *= FRIC;
    p.vy *= FRIC;
    const ps = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (ps > spd * 1.22) { p.vx = p.vx / ps * spd * 1.22; p.vy = p.vy / ps * spd * 1.22; }
    if (ps > 0.001) p.angle = Math.atan2(p.vy, p.vx);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // Limites du terrain
    p.x = Math.max(CAR_W / 2, Math.min(1 - CAR_W / 2, p.x));
    p.y = Math.max(CAR_H / 2, Math.min(1 - CAR_H / 2, p.y));
  });

  // Collision joueurs-balle
  Object.values(room.players).forEach(p => ballCollide(p, room.ball));

  // Physique balle
  const b = room.ball;
  b.x += b.vx * dt * 60;
  b.y += b.vy * dt * 60;
  b.vx *= 0.994;
  b.vy *= 0.994;

  // Murs haut/bas
  if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy) * BNC; }
  if (b.y + b.r > 1) { b.y = 1 - b.r; b.vy = -Math.abs(b.vy) * BNC; }

  // Cages
  const gy1 = 0.5 - GOAL_H / 2;
  const gy2 = 0.5 + GOAL_H / 2;

  // But gauche (équipe B marque)
  if (b.x - b.r < 0) {
    if (b.y > gy1 && b.y < gy2) {
      room.scoreB++;
      handleGoal(room, 1);
      return;
    } else {
      b.x = b.r;
      b.vx = Math.abs(b.vx) * BNC;
    }
  }
  // But droite (équipe A marque)
  if (b.x + b.r > 1) {
    if (b.y > gy1 && b.y < gy2) {
      room.scoreA++;
      handleGoal(room, 0);
      return;
    } else {
      b.x = 1 - b.r;
      b.vx = -Math.abs(b.vx) * BNC;
    }
  }

  // Broadcast état complet à 20fps (toutes les 3 ticks)
  room._broadcastTick = (room._broadcastTick || 0) + 1;
  if (room._broadcastTick % 3 === 0) {
    broadcastState(room);
  }
}

function handleGoal(room, team) {
  room.paused = true;
  broadcast(room, {
    type: 'GOAL',
    team,
    scoreA: room.scoreA,
    scoreB: room.scoreB
  });
  setTimeout(() => {
    if (!rooms[room.id]) return;
    resetBall(room);
    resetPlayerPositions(room);
    room.paused = false;
    broadcastState(room);
  }, 3500); // 3.5s de pause après un but
}

function broadcastState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id,
    x: p.x, y: p.y,
    vx: p.vx, vy: p.vy,
    angle: p.angle,
    team: p.team,
    name: p.name,
    boost: p.boost,
    c1: p.c1, c2: p.c2,
    model: p.model || 0,
    wheelStyle: p.wheelStyle || 0
  }));
  broadcast(room, {
    type: 'GAME_STATE',
    players,
    ball: { x: room.ball.x, y: room.ball.y, vx: room.ball.vx, vy: room.ball.vy },
    scoreA: room.scoreA,
    scoreB: room.scoreB,
    timeLeft: room.timeLeft
  });
}

// ======= WEBSOCKET =======
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let roomId = null;
  console.log(`[+] ${playerId.substring(0, 8)} connecté`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'CREATE_SERVER') {
      const id = Math.random().toString(36).substring(2, 8).toUpperCase();
      rooms[id] = {
        id, map: msg.map ?? 0, time: msg.time ?? 180,
        players: {}, ball: createBall(),
        scoreA: 0, scoreB: 0,
        timeLeft: msg.time ?? 180,
        started: false, paused: false,
        ticker: null
      };
      rooms[id].players[playerId] = {
        id: playerId, ws, name: msg.name ?? 'Joueur',
        team: 0, x: 0.22, y: 0.5, vx: 0, vy: 0, angle: 0,
        boost: 0.8, input: {},
        c1: msg.c1 || '#1a6fff', c2: msg.c2 || '#ff6b00',
        model: msg.model || 0, wheelStyle: msg.wheelStyle || 0
      };
      roomId = id;
      send(ws, { type: 'SERVER_CREATED', serverId: id, playerId });
      console.log(`[ROOM] Créée: ${id}`);
    }

    if (msg.type === 'JOIN_SERVER') {
      const room = rooms[msg.serverId];
      if (!room) { send(ws, { type: 'ERROR', msg: 'Serveur introuvable' }); return; }
      if (Object.keys(room.players).length >= 4) { send(ws, { type: 'ERROR', msg: 'Serveur plein' }); return; }
      if (room.started) { send(ws, { type: 'ERROR', msg: 'Partie en cours' }); return; }
      const team = Object.keys(room.players).length % 2;
      room.players[playerId] = {
        id: playerId, ws, name: msg.name ?? 'Joueur',
        team, x: team === 0 ? 0.22 : 0.78, y: 0.5, vx: 0, vy: 0,
        angle: team === 1 ? Math.PI : 0,
        boost: 0.8, input: {},
        c1: msg.c1 || '#1a6fff', c2: msg.c2 || '#ff6b00',
        model: msg.model || 0, wheelStyle: msg.wheelStyle || 0
      };
      roomId = msg.serverId;
      send(ws, { type: 'JOINED', serverId: roomId, map: room.map, time: room.time, playerId, team });
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
      console.log(`[ROOM] ${msg.name} a rejoint ${roomId}`);
    }

    if (msg.type === 'LAUNCH') {
      const room = rooms[roomId];
      if (!room) return;
      room.started = true;
      room.timeLeft = room.time;
      resetBall(room);
      resetPlayerPositions(room);
      const playerList = Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team }));
      broadcast(room, { type: 'GAME_START', map: room.map, time: room.time, players: playerList });
      // Démarrer la boucle physique
      room.ticker = setInterval(() => tickRoom(room), TICK);
      console.log(`[ROOM] Partie lancée: ${roomId}`);
    }

    if (msg.type === 'HOST_CONFIG') {
      const room = rooms[roomId];
      if (!room) return;
      if (msg.map !== undefined) room.map = msg.map;
      if (msg.time !== undefined) { room.time = msg.time; room.timeLeft = msg.time; }
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }

    // INPUTS du joueur (remplace PLAYER_UPDATE)
    if (msg.type === 'INPUT') {
      const room = rooms[roomId];
      if (!room || !room.players[playerId]) return;
      const p = room.players[playerId];
      p.input = msg.input || {};
      // Mise à jour cosmétique si fournie
      if (msg.c1) p.c1 = msg.c1;
      if (msg.c2) p.c2 = msg.c2;
      if (msg.model !== undefined) p.model = msg.model;
      if (msg.wheelStyle !== undefined) p.wheelStyle = msg.wheelStyle;
    }

    if (msg.type === 'GAME_OVER') {
      const room = rooms[roomId];
      if (!room) return;
      clearInterval(room.ticker);
      broadcast(room, { type: 'GAME_OVER', scoreA: room.scoreA, scoreB: room.scoreB });
      delete rooms[roomId];
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${playerId.substring(0, 8)} déconnecté`);
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.ticker);
      delete rooms[roomId];
      console.log(`[ROOM] Supprimée: ${roomId}`);
    } else {
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }
  });

  ws.on('error', err => console.error(`[ERR] ${err.message}`));
});

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  Object.values(room.players).forEach(p => send(p.ws, msg));
}
function getPlayerList(room) {
  return Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team }));
}

setInterval(() => {
  Object.keys(rooms).forEach(id => {
    if (Object.keys(rooms[id].players).length === 0) {
      clearInterval(rooms[id].ticker);
      delete rooms[id];
    }
  });
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur port ${PORT}`);
});
