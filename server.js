const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// =====================================================================
// CONSTANTES — coordonnées normalisées
// x : fraction de W   (0 = gauche écran, 1 = droite écran)
// y : fraction de H   (0 = haut écran,   1 = bas écran)
//
// Le client utilise:
//   FX = W*0.09  FW = W*0.82  → terrain x ∈ [0.09, 0.91] de W
//   FY = H*0.14  FH = H*0.64  → terrain y ∈ [0.14, 0.78] de H
//   GH = FH*0.3 = H*0.192     → cage y ∈ [0.364, 0.556] de H
// =====================================================================
const FX1 = 0.09, FX2 = 0.91;   // bords terrain (fraction de W)
const FY1 = 0.14, FY2 = 0.78;   // bords terrain (fraction de H)
const FCX = 0.50, FCY = 0.46;   // centre terrain

// Cage: GH = FH*0.3 = 0.64*0.3 = 0.192 de H
// GY1 = FY1 + FH/2 - GH/2 = 0.14 + 0.32 - 0.096 = 0.364
const GY1  = 0.364, GY2 = 0.556;

const BALL_R = 0.020;  // en fraction de W (≈ BR/W pour 16:9: min(W,H)*0.032/W ≈ 0.018)
const CAR_W  = 0.085;  // fraction de W
const CAR_H  = 0.055;  // fraction de H (mais on utilise comme fraction de W pour simplifier)
const CAR_R  = 0.042;  // rayon collision voiture (fraction de W)

// Vitesses en unités-terrain/seconde
// Terrain W = FX2-FX1 = 0.82 de W, terrain H = FY2-FY1 = 0.64 de H
// SPD = 0.28 de W/s → ~54% du terrain par seconde (sensation bonne)
const SPD       = 0.28;
const BOOST_MUL = 1.85;
const FRIC      = 0.84;   // par seconde (^dt dans tickRoom)
const BALL_FRIC = 0.993;  // par frame (^(dt*60))
const BNC       = 0.62;

const TICK_TARGET = 1000 / 60;  // cible 60 ticks/sec
const MAX_DT      = 1 / 30;     // dt max 33ms pour éviter tunneling

const rooms = {};

// =====================================================================
// PHYSIQUE
// =====================================================================
function createBall() {
  const side  = Math.random() > 0.5 ? 0 : Math.PI;
  const angle = side + (Math.random() - 0.5) * 0.8;
  const spd   = 0.20 + Math.random() * 0.06;
  return { x: FCX, y: FCY, vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd * 0.75 };
}

function resetBall(room)    { room.ball = createBall(); }

function resetPlayers(room) {
  const players = Object.values(room.players);
  const cnt = [0, 0];
  players.forEach(p => cnt[p.team]++);
  const idx = [0, 0];
  players.forEach(p => {
    const i = idx[p.team]++;
    const n = cnt[p.team];
    const spread = n > 1 ? (i / (n - 1) - 0.5) * 0.14 : 0;
    p.x     = p.team === 0 ? FX1 + (FX2 - FX1) * 0.22 : FX2 - (FX2 - FX1) * 0.22;
    p.y     = FCY + spread;
    p.vx    = 0; p.vy = 0;
    p.angle = p.team === 1 ? Math.PI : 0;
  });
}

function ballCollide(car, ball) {
  const dx = ball.x - car.x, dy = ball.y - car.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
  const minD = BALL_R + CAR_R;
  if (dist >= minD) return;
  const nx = dx / dist, ny = dy / dist;
  // Vitesses relatives (unités/sec pour les voitures, déjà normalisé pour la balle)
  const rvx = ball.vx - car.vx, rvy = ball.vy - car.vy;
  const dot = rvx * nx + rvy * ny;
  if (dot < 0) {
    const carSpd = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    const imp = -dot * 1.6 + carSpd * 0.5 + 0.08;
    ball.vx += nx * imp;
    ball.vy += ny * imp;
  }
  ball.x = car.x + nx * (minD + 0.002);
  ball.y = car.y + ny * (minD + 0.002);
}

function carCollide(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
  const minD = CAR_R * 2;
  if (dist >= minD) return;
  const nx = dx / dist, ny = dy / dist;
  const overlap = (minD - dist) * 0.5 + 0.001;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;
  const dot = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (dot > 0) {
    const k = 0.55;
    a.vx -= k * dot * nx; a.vy -= k * dot * ny;
    b.vx += k * dot * nx; b.vy += k * dot * ny;
  }
}

function clampPlayer(p) {
  const mx = CAR_W * 0.5, my = CAR_H * 0.5;
  if (p.x < FX1 + mx) { p.x = FX1 + mx; if (p.vx < 0) p.vx *= -0.2; }
  if (p.x > FX2 - mx) { p.x = FX2 - mx; if (p.vx > 0) p.vx *= -0.2; }
  if (p.y < FY1 + my) { p.y = FY1 + my; if (p.vy < 0) p.vy *= -0.2; }
  if (p.y > FY2 - my) { p.y = FY2 - my; if (p.vy > 0) p.vy *= -0.2; }
}

function tickRoom(room) {
  if (!room.started || room.paused || room._gameOverSent) return;

  // ---- dt dynamique (évite dérive timer sur serveurs lents) ----
  const now = Date.now();
  const dt  = Math.min((now - room._lastTick) / 1000, MAX_DT);
  room._lastTick = now;

  // ---- Timer ----
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) {
    room.timeLeft = 0;
    room.started  = false;
    room._gameOverSent = true;
    clearInterval(room.ticker);
    room.ticker = null;
    broadcastState(room);  // dernier état avec timeLeft=0
    broadcast(room, { type: 'GAME_OVER', scoreA: room.scoreA, scoreB: room.scoreB });
    return;
  }

  // ---- Joueurs ----
  const players = Object.values(room.players);
  players.forEach(p => {
    const inp     = p.input || {};
    const boost   = inp.boost && p.boost > 0;
    const spd     = SPD * (boost ? BOOST_MUL : 1.0);
    p.boost = boost
      ? Math.max(0, p.boost - dt * 0.45)
      : Math.min(1, p.boost + dt * 0.22);

    let ax = 0, ay = 0;
    if (inp.up)    ay -= 1;
    if (inp.down)  ay += 1;
    if (inp.left)  ax -= 1;
    if (inp.right) ax += 1;
    const al = Math.sqrt(ax * ax + ay * ay) || 1;

    p.vx += (ax / al) * spd * dt * 4.5;
    p.vy += (ay / al) * spd * dt * 4.5;

    // Friction (^dt pour être frame-rate indépendant)
    const fric = Math.pow(FRIC, dt);
    p.vx *= fric; p.vy *= fric;

    // Clamp vitesse
    const ps = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (ps > spd) { p.vx = (p.vx / ps) * spd; p.vy = (p.vy / ps) * spd; }
    if (ps > 0.004) p.angle = Math.atan2(p.vy, p.vx);

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    clampPlayer(p);
  });

  // ---- Collisions voiture/voiture ----
  for (let i = 0; i < players.length; i++)
    for (let j = i + 1; j < players.length; j++)
      carCollide(players[i], players[j]);

  // ---- Collision balle/voitures ----
  players.forEach(p => ballCollide(p, room.ball));

  // ---- Physique balle ----
  const b = room.ball;
  const bf = Math.pow(BALL_FRIC, dt * 60);
  b.vx *= bf; b.vy *= bf;
  b.x  += b.vx * dt;
  b.y  += b.vy * dt;

  // Murs haut/bas
  if (b.y < FY1 + BALL_R) { b.y = FY1 + BALL_R; b.vy =  Math.abs(b.vy) * BNC; }
  if (b.y > FY2 - BALL_R) { b.y = FY2 - BALL_R; b.vy = -Math.abs(b.vy) * BNC; }

  // Murs latéraux / cage
  if (b.x < FX1 + BALL_R) {
    if (b.y > GY1 && b.y < GY2) { room.scoreB++; handleGoal(room, 1); return; }
    b.x = FX1 + BALL_R; b.vx = Math.abs(b.vx) * BNC;
  }
  if (b.x > FX2 - BALL_R) {
    if (b.y > GY1 && b.y < GY2) { room.scoreA++; handleGoal(room, 0); return; }
    b.x = FX2 - BALL_R; b.vx = -Math.abs(b.vx) * BNC;
  }

  // Broadcast ~20fps (1 tick sur 3 à 60fps)
  room._btick = (room._btick || 0) + 1;
  if (room._btick % 3 === 0) broadcastState(room);
}

function handleGoal(room, scoringTeam) {
  room.paused = true;
  broadcast(room, { type: 'GOAL', team: scoringTeam, scoreA: room.scoreA, scoreB: room.scoreB });
  // Reset positions après 300ms (assez tôt pour que le client le voie pendant le countdown)
  setTimeout(() => {
    if (!rooms[room.id]) return;
    resetBall(room); resetPlayers(room);
    broadcastState(room);
  }, 300);
  // Reprendre le jeu après 4.8s (BUT 2s + attente 0.8s + countdown 3s = 5.8s mais on reprend à 4.8)
  setTimeout(() => {
    if (!rooms[room.id]) return;
    room.paused = false;
    room._lastTick = Date.now(); // réinitialiser le timer pour éviter un gros saut dt
    broadcastState(room);
  }, 5000);
}

function broadcastState(room) {
  broadcast(room, {
    type: 'GAME_STATE',
    t:  room.timeLeft,
    sA: room.scoreA, sB: room.scoreB,
    b:  { x: room.ball.x, y: room.ball.y, vx: room.ball.vx, vy: room.ball.vy },
    p:  Object.values(room.players).map(p => ({
      id: p.id, nm: p.name, tm: p.team,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      a: p.angle, bst: p.boost,
      c1: p.c1, c2: p.c2, md: p.model || 0, ws: p.wheelStyle || 0
    }))
  });
}

// =====================================================================
// WEBSOCKET
// =====================================================================
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let roomId = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'CREATE_SERVER') {
      const id = Math.random().toString(36).slice(2, 8).toUpperCase();
      rooms[id] = {
        id, map: msg.map ?? 0, time: msg.time ?? 180,
        players: {}, ball: createBall(),
        scoreA: 0, scoreB: 0, timeLeft: msg.time ?? 180,
        started: false, paused: false, ticker: null,
        _gameOverSent: false, _btick: 0, _lastTick: Date.now()
      };
      rooms[id].players[playerId] = mkPlayer(playerId, ws, msg.name, 0, msg);
      roomId = id;
      send(ws, { type: 'SERVER_CREATED', serverId: id, playerId });
    }

    if (msg.type === 'JOIN_SERVER') {
      const room = rooms[msg.serverId];
      if (!room)  { send(ws, { type: 'ERROR', msg: 'Serveur introuvable' }); return; }
      if (Object.keys(room.players).length >= 4) { send(ws, { type: 'ERROR', msg: 'Serveur plein' }); return; }
      if (room.started) { send(ws, { type: 'ERROR', msg: 'Partie en cours' }); return; }
      const team = Object.keys(room.players).length % 2;
      room.players[playerId] = mkPlayer(playerId, ws, msg.name, team, msg);
      roomId = msg.serverId;
      send(ws, { type: 'JOINED', serverId: roomId, map: room.map, time: room.time, playerId, team });
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }

    if (msg.type === 'LAUNCH') {
      const room = rooms[roomId];
      if (!room) return;
      room.started = true; room.timeLeft = room.time;
      room.scoreA  = 0; room.scoreB = 0;
      room._gameOverSent = false; room._btick = 0;
      room._lastTick = Date.now();
      resetBall(room); resetPlayers(room);
      broadcast(room, {
        type: 'GAME_START', map: room.map, time: room.time,
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team }))
      });
      if (room.ticker) clearInterval(room.ticker);
      room.ticker = setInterval(() => tickRoom(room), TICK_TARGET);
    }

    if (msg.type === 'HOST_CONFIG') {
      const room = rooms[roomId];
      if (!room) return;
      if (msg.map  !== undefined) room.map = msg.map;
      if (msg.time !== undefined) { room.time = msg.time; room.timeLeft = msg.time; }
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }

    if (msg.type === 'PING') { send(ws, { type: 'PONG' }); return; }

    if (msg.type === 'INPUT') {
      const room = rooms[roomId];
      if (!room || !room.players[playerId]) return;
      const p = room.players[playerId];
      p.input = msg.i || {};
      if (msg.c1) p.c1 = msg.c1;
      if (msg.c2) p.c2 = msg.c2;
      if (msg.md !== undefined) p.model      = msg.md;
      if (msg.ws !== undefined) p.wheelStyle = msg.ws;
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      if (room.ticker) clearInterval(room.ticker);
      delete rooms[roomId];
    } else {
      broadcast(room, { type: 'ROOM_UPDATE', players: getPlayerList(room), map: room.map, time: room.time });
    }
  });

  ws.on('error', err => console.error(`[WS ERR] ${err.message}`));
});

function mkPlayer(id, ws, name, team, msg) {
  return {
    id, ws, name: (name || 'Joueur').slice(0, 18), team,
    x: team === 0 ? FX1 + (FX2-FX1)*0.22 : FX2 - (FX2-FX1)*0.22,
    y: FCY, vx: 0, vy: 0,
    angle: team === 1 ? Math.PI : 0, boost: 0.8, input: {},
    c1: msg?.c1 || '#1a6fff', c2: msg?.c2 || '#ff6b00',
    model: msg?.model || 0, wheelStyle: msg?.wheelStyle || 0
  };
}
function send(ws, msg)      { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(room, m) { Object.values(room.players).forEach(p => send(p.ws, m)); }
function getPlayerList(r)   { return Object.values(r.players).map(p => ({ id: p.id, name: p.name, team: p.team })); }

setInterval(() => {
  Object.keys(rooms).forEach(id => {
    if (Object.keys(rooms[id].players).length === 0) {
      if (rooms[id].ticker) clearInterval(rooms[id].ticker);
      delete rooms[id];
    }
  });
}, 5 * 60 * 1000);

setInterval(() => {
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.ping(); });
}, 25000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Serveur lancé — port ${PORT}`));
