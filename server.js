const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Database Schema (MongoDB Atlas ya Local Memory) ---
const MONGO_URI = process.env.MONGO_URI || ""; // Render Environment Variable se lega
let useMongo = false;

const userSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true },
  name: { type: String, default: "Player" },
  pin: { type: String, required: true },
  chips: { type: Number, default: 1000 },
  gamesPlayed: { type: Number, default: 0 },
  gamesWon: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => { console.log("MongoDB Connected!"); useMongo = true; })
    .catch(err => console.log("Mongo error, fallback to memory:", err));
}

// In-Memory Storage (agar MongoDB set na ho tab bhi chalega)
const memoryUsers = {};

async function getUser(phone) {
  if (useMongo) return await User.findOne({ phone });
  return memoryUsers[phone] || null;
}

async function saveUser(userData) {
  if (useMongo) {
    let u = await User.findOne({ phone: userData.phone });
    if (!u) u = new User(userData);
    else Object.assign(u, userData);
    return await u.save();
  } else {
    memoryUsers[userData.phone] = userData;
    return userData;
  }
}

// --- Game Logic ---
const rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function getAddValue(r) { return ['K','Q','J'].includes(r) ? 0 : (r === 'A' ? 1 : parseInt(r)); }
function getPowerRank(r) { return {'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13}[r]; }
function getUnitScore(cards) { return cards.reduce((acc, c) => acc + getAddValue(c.rank), 0) % 10; }

function getTrioScore(cards) {
  if (cards.every(c => c.rank === 'K')) return 3;
  if (cards.every(c => c.rank === 'Q')) return 2;
  if (cards.every(c => c.rank === 'J')) return 1;
  return 0;
}

function decideWinner(p1, p2) {
  let t1 = getTrioScore(p1.cards), t2 = getTrioScore(p2.cards);
  if (t1 > 0 || t2 > 0) return t1 > t2 ? p1 : (t2 > t1 ? p2 : p2);

  let u1 = getUnitScore(p1.cards), u2 = getUnitScore(p2.cards);
  if (u1 > u2) return p1;
  if (u2 > u1) return p2;

  let r1 = p1.cards.map(c => getPowerRank(c.rank)).sort((a,b)=>b-a);
  let r2 = p2.cards.map(c => getPowerRank(c.rank)).sort((a,b)=>b-a);
  for (let i = 0; i < 3; i++) {
    if (r1[i] > r2[i]) return p1;
    if (r2[i] > r1[i]) return p2;
  }
  return p2;
}

function resetTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timeLeft = 30;

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit('timerUpdate', { timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      const activePlayer = room.players[room.activeIdx];
      if (activePlayer && !activePlayer.folded) {
        activePlayer.folded = true;
        io.to(room.id).emit('playerMessage', `${activePlayer.name} timed out aur Fold ho gaya!`);
        nextTurn(room);
      }
    }
  }, 1000);
}

async function finishGame(room, winner) {
  if (room.timer) clearInterval(room.timer);
  winner.chips += room.pot;

  // Track record database me update karein
  for (let p of room.players) {
    let u = await getUser(p.phone);
    if (u) {
      u.chips = p.chips;
      u.gamesPlayed = (u.gamesPlayed || 0) + 1;
      if (p.id === winner.id) u.gamesWon = (u.gamesWon || 0) + 1;
      await saveUser(u);
    }
  }

  io.to(room.id).emit('gameOver', { 
    message: `🏆 ${winner.name} won ₹${room.pot}!`,
    winnerPhone: winner.phone 
  });

  setTimeout(() => {
    startRound(room);
    broadcastRoom(room.id);
  }, 5000);
}

function startRound(room) {
  let deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ suit: s, rank: r })));
  deck.sort(() => Math.random() - 0.5);

  room.pot = 0;
  room.currentBet = 1;
  room.lastMoveWasSeen = false;

  room.players.forEach(p => {
    p.chips -= 1; // Boot ₹1
    room.pot += 1;
    p.state = 'blind';
    p.folded = false;
    p.cards = [deck.pop(), deck.pop(), deck.pop()];
  });

  room.activeIdx = 0;
  resetTimer(room);
}

function sanitizeRoomState(room, phone) {
  return {
    roomId: room.id,
    pot: room.pot,
    currentBet: room.currentBet,
    activeIdx: room.activeIdx,
    lastMoveWasSeen: room.lastMoveWasSeen,
    timeLeft: room.timeLeft || 30,
    players: room.players.map((p) => ({
      id: p.id,
      phone: p.phone,
      name: p.name,
      chips: p.chips,
      state: p.state,
      folded: p.folded,
      isOnline: p.isOnline,
      isYou: p.phone === phone,
      cards: (p.phone === phone && p.state === 'seen') ? p.cards : null,
      unitScore: (p.phone === phone && p.state === 'seen') ? getUnitScore(p.cards) : null,
    }))
  };
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit('gameState', sanitizeRoomState(room, p.phone));
    }
  });
}

function nextTurn(room) {
  let alive = room.players.filter(p => !p.folded);
  if (alive.length <= 1) {
    let winner = alive[0] || room.players[0];
    finishGame(room, winner);
    return;
  }

  do {
    room.activeIdx = (room.activeIdx + 1) % room.players.length;
  } while (room.players[room.activeIdx].folded);

  resetTimer(room);
  broadcastRoom(room.id);
}

io.on('connection', (socket) => {
  // Mobile Login / Register
  socket.on('authLogin', async ({ phone, pin, name }) => {
    if (!phone || phone.length < 10 || !pin) {
      return socket.emit('authError', 'Kripya sahi 10-digit mobile number aur 4-digit PIN dalein!');
    }

    let user = await getUser(phone);
    if (!user) {
      // Naya Account
      user = {
        phone,
        name: name || `Player_${phone.slice(-4)}`,
        pin,
        chips: 1000,
        gamesPlayed: 0,
        gamesWon: 0
      };
      await saveUser(user);
    } else {
      // Purana Account check PIN
      if (user.pin !== pin) {
        return socket.emit('authError', 'Galat PIN! Dubara koshish karein.');
      }
    }

    socket.emit('authSuccess', {
      phone: user.phone,
      name: user.name,
      chips: user.chips,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon
    });
  });

  // Table Join
  socket.on('joinOrCreateRoom', async ({ roomId, phone }) => {
    const user = await getUser(phone);
    if (!user) return socket.emit('errorMsg', 'Session expire ho gaya, dubara login karein.');

    let room = rooms[roomId];
    if (!room) {
      room = {
        id: roomId,
        pot: 0,
        currentBet: 1,
        activeIdx: 0,
        lastMoveWasSeen: false,
        players: [],
        timer: null,
        timeLeft: 30
      };
      rooms[roomId] = room;
    }

    // Reconnect Check
    let p = room.players.find(x => x.phone === phone);
    if (p) {
      p.socketId = socket.id;
      p.isOnline = true;
      socket.join(roomId);
      broadcastRoom(roomId);
      return;
    }

    if (room.players.length >= 10) return socket.emit('errorMsg', 'Table Full hai (Max 10)!');

    room.players.push({
      id: 'p_' + phone,
      phone: user.phone,
      socketId: socket.id,
      name: user.name,
      chips: user.chips,
      state: 'blind',
      cards: [],
      folded: false,
      isOnline: true
    });

    socket.join(roomId);
    if (room.players.length === 2 && room.pot === 0) {
      startRound(room);
    }
    broadcastRoom(roomId);
  });

  socket.on('action', ({ roomId, phone, type, amount }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[room.activeIdx];
    if (!player || player.phone !== phone) return socket.emit('errorMsg', 'Aapki turn nahi hai!');

    if (type === 'SEE') {
      player.state = 'seen';
      broadcastRoom(roomId);
      return;
    }

    if (type === 'CHAAL') {
      let raise = parseInt(amount);
      if (isNaN(raise) || raise <= room.currentBet) {
        return socket.emit('errorMsg', `Chaal amount ₹${room.currentBet} se zyada honi chahiye!`);
      }
      if (player.chips < raise) return socket.emit('errorMsg', 'Balance kam hai!');

      player.chips -= raise;
      room.pot += raise;
      room.currentBet = raise;
      room.lastMoveWasSeen = (player.state === 'seen');
      nextTurn(room);
    } else if (type === 'BAND') {
      if (player.state !== 'blind') return socket.emit('errorMsg', 'Sirf Blind player BAND kar sakta hai!');
      if (player.chips < room.currentBet) return socket.emit('errorMsg', 'Balance kam hai!');

      player.chips -= room.currentBet;
      room.pot += room.currentBet;
      room.currentBet *= 2;
      room.lastMoveWasSeen = false;
      nextTurn(room);
    } else if (type === 'COUNTER') {
      if (player.state !== 'blind' || !room.lastMoveWasSeen) {
        return socket.emit('errorMsg', 'Counter tabhi chalega jab samne wale ne SEEN chala ho!');
      }
      let counterBet = room.currentBet * 3;
      if (player.chips < counterBet) return socket.emit('errorMsg', 'Balance kam hai!');

      player.chips -= counterBet;
      room.pot += counterBet;
      room.currentBet = counterBet;
      room.lastMoveWasSeen = false;
      nextTurn(room);
    } else if (type === 'PACK') {
      player.folded = true;
      nextTurn(room);
    } else if (type === 'SHOW') {
      let alive = room.players.filter(p => !p.folded);
      if (alive.length > 2) return socket.emit('errorMsg', 'Show sirf 2 players bache hone par hoga!');
      
      let caller = player;
      let opp = alive.find(p => p.phone !== caller.phone);
      let winner = decideWinner(caller, opp);

      io.to(roomId).emit('showResult', {
        winnerName: winner.name,
        pot: room.pot,
        p1: { name: caller.name, cards: caller.cards, score: getUnitScore(caller.cards) },
        p2: { name: opp.name, cards: opp.cards, score: getUnitScore(opp.cards) },
      });

      finishGame(room, winner);
    }
  });

  socket.on('disconnect', () => {
    for (const rId in rooms) {
      const room = rooms[rId];
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) {
        p.isOnline = false;
        broadcastRoom(rId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
