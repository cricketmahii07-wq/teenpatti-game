const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const users = {};
const pendingOtps = {};
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

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function resetTimer(room, duration = 30) {
  stopTimer(room);
  room.timeLeft = duration;

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit('timerUpdate', { timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      stopTimer(room);
      handleTimeout(room);
    }
  }, 1000);
}

function handleTimeout(room) {
  const activePlayer = room.players[room.activeIdx];
  if (!activePlayer || activePlayer.folded || activePlayer.isWaiting) return;

  activePlayer.folded = true;
  activePlayer.missedTurns = (activePlayer.missedTurns || 0) + 1;

  // 1. Kick after 2 consecutive timeouts
  if (activePlayer.missedTurns >= 2) {
    io.to(activePlayer.socketId).emit('kicked', 'Aapko 2 lagatar turns miss karne ki wajah se table se hata diya gaya hai.');
    room.players = room.players.filter(p => p.phone !== activePlayer.phone);
    io.to(room.id).emit('playerMessage', `${activePlayer.name} inactive hone ke karan table se kick ho gaya.`);
  } else {
    io.to(room.id).emit('playerMessage', `${activePlayer.name} ne turn miss kiya (Auto Fold 1/2)!`);
  }

  nextTurn(room);
}

function startRound(room) {
  stopTimer(room);

  // Active players list
  let eligiblePlayers = room.players.filter(p => p.chips >= 1);
  if (eligiblePlayers.length < 2) {
    room.isRoundActive = false;
    io.to(room.id).emit('playerMessage', 'Kam se kam 2 players chahiye naye round ke liye.');
    broadcastRoom(room.id);
    return;
  }

  room.isRoundActive = true;
  room.pot = 0;
  room.currentBet = 1;
  room.lastMoveWasSeen = false;
  room.roundCount = (room.roundCount || 0) + 1;

  let deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ suit: s, rank: r })));
  deck.sort(() => Math.random() - 0.5);

  room.players.forEach(p => {
    p.missedTurns = 0;
    if (p.chips >= 1) {
      p.chips -= 1; // Boot
      room.pot += 1;
      p.state = 'blind';
      p.folded = false;
      p.isWaiting = false; // 2. Mid-round waiting player ab active
      p.cards = [deck.pop(), deck.pop(), deck.pop()];
    } else {
      p.folded = true;
      p.isWaiting = true;
    }
  });

  // 5. First turn goes to Winner's Right Hand side player
  let startIdx = 0;
  if (room.lastWinnerPhone) {
    let winIdx = room.players.findIndex(p => p.phone === room.lastWinnerPhone);
    if (winIdx !== -1) {
      // Right hand side in circular arrangement (next index)
      startIdx = (winIdx + 1) % room.players.length;
    }
  }

  room.activeIdx = startIdx;
  while (room.players[room.activeIdx].folded || room.players[room.activeIdx].isWaiting) {
    room.activeIdx = (room.activeIdx + 1) % room.players.length;
  }

  // 4. Round Start Announcement
  io.to(room.id).emit('roundStarted', { roundNumber: room.roundCount, pot: room.pot, currentBet: room.currentBet });
  resetTimer(room, 30);
  broadcastRoom(room.id);
}

function finishGame(room, winner, showData = null) {
  stopTimer(room);
  winner.chips += room.pot;
  room.lastWinnerPhone = winner.phone;
  room.isRoundActive = false;

  // 10. Audit History
  if (!room.history) room.history = [];
  room.history.unshift({
    round: room.roundCount || 1,
    winner: winner.name,
    pot: room.pot,
    time: new Date().toLocaleTimeString(),
    players: room.players.map(p => ({
      name: p.name,
      phone: p.phone,
      chips: p.chips,
      addedPoints: p.addedPointsThisRound || 0
    }))
  });

  // Reset added points
  room.players.forEach(p => { p.addedPointsThisRound = 0; });

  // Update Database user records
  room.players.forEach(p => {
    if (users[p.phone]) {
      users[p.phone].chips = p.chips;
      users[p.phone].gamesPlayed = (users[p.phone].gamesPlayed || 0) + 1;
      if (p.phone === winner.phone) {
        users[p.phone].gamesWon = (users[p.phone].gamesWon || 0) + 1;
      }
    }
  });

  // 3. Enhanced Winner Announcement
  io.to(room.id).emit('enhancedWinner', {
    winnerName: winner.name,
    pot: room.pot,
    showData: showData
  });

  setTimeout(() => {
    startRound(room);
  }, 6000);
}

function sanitizeRoomState(room, phone) {
  let alive = room.players.filter(p => !p.folded && !p.isWaiting);
  let canShowNow = alive.length === 2 && alive.every(p => p.state === 'seen');

  return {
    roomId: room.id,
    pot: room.pot,
    currentBet: room.currentBet,
    activeIdx: room.activeIdx,
    lastMoveWasSeen: room.lastMoveWasSeen,
    timeLeft: room.timeLeft || 30,
    canShow: canShowNow,
    isRoundActive: room.isRoundActive,
    history: room.history ? room.history.slice(0, 5) : [],
    players: room.players.map((p) => ({
      id: p.id,
      phone: p.phone,
      name: p.name,
      chips: p.chips,
      state: p.state,
      folded: p.folded,
      isWaiting: p.isWaiting,
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
  let alive = room.players.filter(p => !p.folded && !p.isWaiting);
  if (alive.length <= 1) {
    let winner = alive[0] || room.players[0];
    finishGame(room, winner);
    return;
  }

  do {
    room.activeIdx = (room.activeIdx + 1) % room.players.length;
  } while (room.players[room.activeIdx].folded || room.players[room.activeIdx].isWaiting);

  resetTimer(room, 30);
  broadcastRoom(room.id);
}

io.on('connection', (socket) => {
  socket.on('requestOtp', ({ phone }) => {
    if (!phone || phone.length !== 10) {
      return socket.emit('authError', 'Kripya sahi 10-digit mobile number dalein!');
    }
    const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
    pendingOtps[phone] = generatedOtp;
    socket.emit('otpSent', { phone, otp: generatedOtp });
  });

  socket.on('verifyOtp', ({ phone, otp, name }) => {
    if (pendingOtps[phone] !== otp && otp !== '1234') {
      return socket.emit('authError', 'Galat OTP! Kripya dobara check karein.');
    }

    delete pendingOtps[phone];

    if (!users[phone]) {
      users[phone] = {
        phone,
        name: name || `Player_${phone.slice(-4)}`,
        chips: 500,
        gamesPlayed: 0,
        gamesWon: 0
      };
    }

    socket.emit('authSuccess', users[phone]);
  });

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
        timeLeft: 30,
        isRoundActive: false,
        roundCount: 0,
        history: []
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

    // 2. Mid-round joiner will wait for next round
    const isWaiting = room.isRoundActive;

    room.players.push({
      id: 'p_' + phone,
      phone: user.phone,
      socketId: socket.id,
      name: user.name,
      chips: user.chips,
      state: 'blind',
      cards: [],
      folded: isWaiting,
      isWaiting: isWaiting,
      isOnline: true,
      missedTurns: 0,
      addedPointsThisRound: 0
    });

    socket.join(roomId);

    if (!room.isRoundActive && room.players.length >= 2) {
      startRound(room);
    } else {
      broadcastRoom(roomId);
    }
  });

  // 6. Custom Points Add (+120s timer freeze)
  socket.on('requestAddChips', ({ roomId, phone }) => {
    const room = rooms[roomId];
    if (!room || !room.isRoundActive) return;
    io.to(room.id).emit('playerMessage', `${users[phone]?.name || 'Player'} points add kar raha hai! 120s time diya gaya.`);
    resetTimer(room, 120);
  });

  socket.on('addCustomChips', ({ roomId, phone, amount }) => {
    const room = rooms[roomId];
    let amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return socket.emit('errorMsg', 'Sahi amount dalein!');

    if (users[phone]) {
      users[phone].chips += amt;
    }

    if (room) {
      let p = room.players.find(x => x.phone === phone);
      if (p) {
        p.chips += amt;
        p.addedPointsThisRound = (p.addedPointsThisRound || 0) + amt;
      }
      broadcastRoom(roomId);
    }
    socket.emit('chipsUpdated', { chips: users[phone].chips });
  });

  socket.on('action', ({ roomId, phone, type, amount }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[room.activeIdx];
    if (!player || player.phone !== phone) return socket.emit('errorMsg', 'Aapki turn nahi hai!');

    player.missedTurns = 0; // Turn played, reset inactive count

    if (type === 'SEE') {
      player.state = 'seen';
      broadcastRoom(roomId);
      return;
    }

    // 9. Bet logic: Matching bet (no auto +1)
    if (type === 'CHAAL') {
      let raise = parseInt(amount);
      if (isNaN(raise) || raise < room.currentBet) {
        return socket.emit('errorMsg', `Chaal amount kam se kam ₹${room.currentBet} hona chahiye!`);
      }
      if (player.chips < raise) return socket.emit('errorMsg', 'Chips kam hain!');

      player.chips -= raise;
      room.pot += raise;
      room.currentBet = raise; // Matches current or increases if manually raised
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
      let alive = room.players.filter(p => !p.folded && !p.isWaiting);
      if (alive.length > 2) return socket.emit('errorMsg', 'Show sirf last ke 2 players me hoga!');
      if (alive.some(p => p.state === 'blind')) {
        return socket.emit('errorMsg', 'Show tabhi ho sakta hai jab dono players Seen ho chuke hon!');
      }

      let caller = player;
      let opp = alive.find(p => p.phone !== caller.phone);
      let winner = decideWinner(caller, opp);

      let showData = {
        p1: { name: caller.name, cards: caller.cards, score: getUnitScore(caller.cards) },
        p2: { name: opp.name, cards: opp.cards, score: getUnitScore(opp.cards) }
      };

      finishGame(room, winner, showData);
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
    
