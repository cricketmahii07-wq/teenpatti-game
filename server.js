const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-Memory Database (Phone -> User & OTP)
const users = {};
const pendingOtps = {};

// Game Engine Memory
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

function startRound(room) {
  let deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ suit: s, rank: r })));
  deck.sort(() => Math.random() - 0.5);

  room.pot = 0;
  room.currentBet = 1;
  room.lastMoveWasSeen = false;

  room.players.forEach(p => {
    p.chips -= 1;
    room.pot += 1;
    p.state = 'blind';
    p.folded = false;
    p.cards = [deck.pop(), deck.pop(), deck.pop()];
  });

  room.activeIdx = 0;
  resetTimer(room);
}

function finishGame(room, winner) {
  if (room.timer) clearInterval(room.timer);
  winner.chips += room.pot;

  room.players.forEach(p => {
    if (users[p.phone]) {
      users[p.phone].chips = p.chips;
      users[p.phone].gamesPlayed = (users[p.phone].gamesPlayed || 0) + 1;
      if (p.phone === winner.phone) {
        users[p.phone].gamesWon = (users[p.phone].gamesWon || 0) + 1;
      }
    }
  });

  io.to(room.id).emit('gameOver', { 
    message: `🏆 ${winner.name} won ₹${room.pot}!`,
    winnerPhone: winner.phone 
  });

  setTimeout(() => {
    startRound(room);
    broadcastRoom(room.id);
  }, 5000);
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
  // 1. Send OTP
  socket.on('requestOtp', ({ phone }) => {
    if (!phone || phone.length !== 10) {
      return socket.emit('authError', 'Kripya sahi 10-digit mobile number dalein!');
    }
    const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
    pendingOtps[phone] = generatedOtp;

    // Send OTP to client
    socket.emit('otpSent', { phone, otp: generatedOtp });
  });

  // 2. Verify OTP & Register/Login
  socket.on('verifyOtp', ({ phone, otp, name }) => {
    if (pendingOtps[phone] !== otp && otp !== '1234') { // 1234 demo bypass code
      return socket.emit('authError', 'Galat OTP! Kripya dobara check karein.');
    }

    delete pendingOtps[phone];

    if (!users[phone]) {
      users[phone] = {
        phone,
        name: name || `Player_${phone.slice(-4)}`,
        chips: 1000,
        gamesPlayed: 0,
        gamesWon: 0
      };
    }

    socket.emit('authSuccess', users[phone]);
  });

  // 3. Room Management
  socket.on('joinOrCreateRoom', ({ roomId, phone }) => {
    const user = users[phone];
    if (!user) return socket.emit('errorMsg', 'Session expired, login again!');

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

    let p = room.players.find(x => x.phone === phone);
    if (p) {
      p.socketId = socket.id;
      p.isOnline = true;
      socket.join(roomId);
      broadcastRoom(roomId);
      return;
    }

    if (room.players.length >= 10) return socket.emit('errorMsg', 'Table Full (Max 10 players)!');

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

  // 4. In-Game Actions
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
        return socket.emit('errorMsg', `Chaal amount ₹${room.currentBet} se zyada hona chahiye!`);
      }
      if (player.chips < raise) return socket.emit('errorMsg', 'Chips kam hain!');

      player.chips -= raise;
      room.pot += raise;
      room.currentBet = raise;
      room.lastMoveWasSeen = (player.state === 'seen');
      nextTurn(room);
    } else if (type === 'BAND') {
      if (player.state !== 'blind') return socket.emit('errorMsg', 'Sirf Blind player BAND kar sakta hai!');
      if (player.chips < room.currentBet) return socket.emit('errorMsg', 'Chips kam hain!');

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
      if (player.chips < counterBet) return socket.emit('errorMsg', 'Chips kam hain!');

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
      if (alive.length > 2) return socket.emit('errorMsg', 'Show sirf last ke 2 players me hoga!');

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
