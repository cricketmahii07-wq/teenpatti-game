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

  if (activePlayer.missedTurns >= 2 && !activePlayer.isBot) {
    io.to(activePlayer.socketId).emit('kicked', '2 lagatar turns miss karne ki wajah se remove kiya gaya.');
    room.players = room.players.filter(p => p.phone !== activePlayer.phone);
  }

  room.lastMoveAnnouncement = `${activePlayer.name} timed out aur Fold ho gaya!`;
  nextTurn(room);
}

function startRound(room) {
  stopTimer(room);

  let eligiblePlayers = room.players.filter(p => p.chips >= 1);
  if (eligiblePlayers.length < 2) {
    room.isRoundActive = false;
    broadcastRoom(room.id);
    return;
  }

  room.isRoundActive = true;
  room.pot = 0;
  room.currentBet = 1;
  room.lastMoveWasSeen = false;
  room.lastMoveAnnouncement = "Round Shuru Hua! Boot ₹1 Collect hua.";
  room.roundCount = (room.roundCount || 0) + 1;

  let deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ suit: s, rank: r })));
  deck.sort(() => Math.random() - 0.5);

  room.players.forEach(p => {
    p.missedTurns = 0;
    if (p.chips >= 1) {
      p.chips -= 1;
      room.pot += 1;
      p.state = 'blind';
      p.folded = false;
      p.isWaiting = false;
      p.cards = [deck.pop(), deck.pop(), deck.pop()];
      p.bluff = Math.random() < 0.20;
    } else {
      p.folded = true;
      p.isWaiting = true;
    }
  });

  let startIdx = 0;
  if (room.lastWinnerPhone) {
    let winIdx = room.players.findIndex(p => p.phone === room.lastWinnerPhone);
    if (winIdx !== -1) startIdx = (winIdx + 1) % room.players.length;
  }

  room.activeIdx = startIdx;
  while (room.players[room.activeIdx].folded || room.players[room.activeIdx].isWaiting) {
    room.activeIdx = (room.activeIdx + 1) % room.players.length;
  }

  io.to(room.id).emit('roundStarted', { roundNumber: room.roundCount, pot: room.pot, currentBet: room.currentBet });
  resetTimer(room, 30);
  broadcastRoom(room.id);

  checkBotTurn(room);
}

function finishGame(room, winner, showData = null) {
  stopTimer(room);
  winner.chips += room.pot;
  room.lastWinnerPhone = winner.phone;
  room.isRoundActive = false;

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

  room.players.forEach(p => {
    p.addedPointsThisRound = 0;
    if (users[p.phone]) {
      users[p.phone].chips = p.chips;
      users[p.phone].gamesPlayed = (users[p.phone].gamesPlayed || 0) + 1;
      if (p.phone === winner.phone) users[p.phone].gamesWon = (users[p.phone].gamesWon || 0) + 1;
    }
  });

  io.to(room.id).emit('enhancedWinner', {
    winnerName: winner.name,
    pot: room.pot,
    showData: showData
  });

  setTimeout(() => {
    room.players.forEach(p => {
      if (p.isBot && p.chips < 50) p.chips += 500;
    });
    startRound(room);
  }, 5000);
}

function sanitizeRoomState(room, phone) {
  let alive = room.players.filter(p => !p.folded && !p.isWaiting);
  let canShowNow = room.isRoundActive && alive.length === 2 && alive.every(p => p.state === 'seen');

  return {
    roomId: room.id,
    pot: room.pot,
    currentBet: room.currentBet,
    activeIdx: room.activeIdx,
    lastMoveWasSeen: room.lastMoveWasSeen,
    lastMoveAnnouncement: room.lastMoveAnnouncement || "",
    timeLeft: room.timeLeft || 30,
    canShow: canShowNow,
    isRoundActive: room.isRoundActive,
    totalPlayers: room.players.length,
    activeCount: alive.length,
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
      isBot: p.isBot || false,
      isYou: p.phone === phone,
      cards: (p.phone === phone && p.state === 'seen') ? p.cards : null,
      unitScore: (p.phone === phone && p.state === 'seen') ? getUnitScore(p.cards) : null,
      addedPointsThisRound: p.addedPointsThisRound || 0
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
  checkBotTurn(room);
}

// --- Smart Bot with Updated Band / Counter ---
function checkBotTurn(room) {
  if (!room.isRoundActive) return;
  const p = room.players[room.activeIdx];
  if (!p || !p.isBot || p.folded || p.isWaiting) return;

  const delay = Math.floor(1500 + Math.random() * 1500);
  setTimeout(() => {
    if (!room.isRoundActive || room.players[room.activeIdx]?.phone !== p.phone) return;
    executeBotAction(room, p);
  }, delay);
}

function executeBotAction(room, bot) {
  let alive = room.players.filter(x => !x.folded && x.id !== bot.id && !x.isWaiting);
  let otherPlayer = alive[0];

  let trio = getTrioScore(bot.cards);
  let score = getUnitScore(bot.cards);
  let isStrong = trio > 0 || score >= 7;
  let isMedium = score >= 4 && score < 7;
  let isWeak = score < 4 && trio === 0;

  if (bot.state === 'blind') {
    if (Math.random() < 0.5 && !bot.bluff) {
      bot.state = 'seen';
      room.lastMoveAnnouncement = `${bot.name} ne Cards DEKHE!`;
      broadcastRoom(room.id);
      setTimeout(() => executeBotAction(room, bot), 1000);
      return;
    } else {
      // Band (2x multiplier set for next player)
      if (Math.random() < 0.25) {
        let basePay = room.currentBet;
        if (bot.chips < basePay) {
          bot.folded = true;
          return nextTurn(room);
        }
        bot.chips -= basePay;
        room.pot += basePay;
        room.currentBet = basePay * 2;
        room.lastMoveWasSeen = false;
        room.lastMoveAnnouncement = `${bot.name} ne BAND kiya ₹${basePay}! (Agle ke liye bet: ₹${room.currentBet})`;
        return nextTurn(room);
      } else {
        // Blind Chaal
        let basePay = room.currentBet;
        bot.chips -= basePay;
        room.pot += basePay;
        room.lastMoveWasSeen = false;
        room.lastMoveAnnouncement = `${bot.name} ne Blind Chaal chali: ₹${basePay}`;
        return nextTurn(room);
      }
    }
  }

  let canShow = alive.length === 1 && otherPlayer && otherPlayer.state === 'seen';
  if (canShow && (isStrong || (isMedium && room.currentBet > 15))) {
    let winner = decideWinner(bot, otherPlayer);
    let showData = {
      p1: { name: bot.name, cards: bot.cards, score: getUnitScore(bot.cards) },
      p2: { name: otherPlayer.name, cards: otherPlayer.cards, score: getUnitScore(otherPlayer.cards) }
    };
    room.lastMoveAnnouncement = `${bot.name} ne SHOW mangwaya!`;
    return finishGame(room, winner, showData);
  }

  if (isWeak && !bot.bluff && room.currentBet >= 5) {
    bot.folded = true;
    room.lastMoveAnnouncement = `${bot.name} PACK ho gaya!`;
    return nextTurn(room);
  }

  let betAmt = room.currentBet;
  if ((isStrong || bot.bluff) && Math.random() < 0.35) {
    betAmt += (Math.random() < 0.5 ? 2 : 5);
  }

  if (bot.chips < betAmt) {
    bot.folded = true;
    room.lastMoveAnnouncement = `${bot.name} Chips khatam hone par PACK hua!`;
    return nextTurn(room);
  }

  bot.chips -= betAmt;
  room.pot += betAmt;
  room.currentBet = betAmt;
  room.lastMoveWasSeen = true;
  room.lastMoveAnnouncement = `${bot.name} ne Chaal chali: ₹${betAmt}`;
  nextTurn(room);
}

io.on('connection', (socket) => {
  socket.on('requestOtp', ({ phone }) => {
    if (!phone || phone.length !== 10) return socket.emit('authError', '10-digit number dalein!');
    const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
    pendingOtps[phone] = generatedOtp;
    socket.emit('otpSent', { phone, otp: generatedOtp });
  });

  socket.on('verifyOtp', ({ phone, otp, name }) => {
    if (pendingOtps[phone] !== otp && otp !== '1234') return socket.emit('authError', 'Galat OTP!');
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
        lastMoveAnnouncement: "Lobby me players ka wait chal raha hai...",
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

    if (room.players.length >= 10) return socket.emit('errorMsg', 'Table Full hai!');

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
      addedPointsThisRound: 0,
      isBot: false
    });

    socket.join(roomId);

    if (!room.isRoundActive && room.players.length >= 2) {
      startRound(room);
    } else {
      broadcastRoom(roomId);
    }
  });

  socket.on('createBotRoom', ({ phone, botCount }) => {
    const user = users[phone];
    if (!user) return socket.emit('errorMsg', 'Session expired, login again!');

    const roomId = 'BOT_' + Math.floor(1000 + Math.random() * 9000);
    const count = Math.min(Math.max(parseInt(botCount) || 1, 1), 4);

    let room = {
      id: roomId,
      pot: 0,
      currentBet: 1,
      activeIdx: 0,
      lastMoveWasSeen: false,
      lastMoveAnnouncement: "Bot game start ho raha hai...",
      players: [
        {
          id: 'p_' + phone,
          phone: user.phone,
          socketId: socket.id,
          name: user.name,
          chips: user.chips,
          state: 'blind',
          cards: [],
          folded: false,
          isWaiting: false,
          isOnline: true,
          missedTurns: 0,
          addedPointsThisRound: 0,
          isBot: false
        }
      ],
      timer: null,
      timeLeft: 30,
      isRoundActive: false,
      roundCount: 0,
      history: []
    };

    const botNames = ['Kabir (AI)', 'Rocky (AI)', 'Simran (AI)', 'Veer (AI)'];
    for (let i = 0; i < count; i++) {
      room.players.push({
        id: 'bot_' + i,
        phone: 'BOT_' + i,
        socketId: null,
        name: botNames[i] || `Bot_${i + 1}`,
        chips: 500,
        state: 'blind',
        cards: [],
        folded: false,
        isWaiting: false,
        isOnline: true,
        missedTurns: 0,
        addedPointsThisRound: 0,
        isBot: true
      });
    }

    rooms[roomId] = room;
    socket.join(roomId);
    startRound(room);
  });

  socket.on('requestAddChips', ({ roomId, phone }) => {
    const room = rooms[roomId];
    if (!room || !room.isRoundActive) return;
    room.lastMoveAnnouncement = `${users[phone]?.name || 'Player'} points add kar raha hai (+120s)`;
    resetTimer(room, 120);
    broadcastRoom(roomId);
  });

  socket.on('addCustomChips', ({ roomId, phone, amount }) => {
    const room = rooms[roomId];
    let amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return socket.emit('errorMsg', 'Sahi amount dalein!');

    if (users[phone]) users[phone].chips += amt;

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

  // Action Handling with Exact Custom Band / Counter Rules
  socket.on('action', ({ roomId, phone, type, amount }) => {
    const room = rooms[roomId];
    if (!room || !room.isRoundActive) return;

    let eligible = room.players.filter(p => !p.folded && !p.isWaiting);
    if (eligible.length < 2) return socket.emit('errorMsg', 'Dusre player ka wait karein!');

    const player = room.players[room.activeIdx];
    if (!player || player.phone !== phone) return socket.emit('errorMsg', 'Aapki turn nahi hai!');

    player.missedTurns = 0;

    if (type === 'SEE') {
      player.state = 'seen';
      room.lastMoveAnnouncement = `${player.name} ne Cards DEKHE!`;
      broadcastRoom(roomId);
      return;
    }

    let customInput = parseInt(amount) || room.currentBet;

    if (type === 'CHAAL') {
      if (customInput < room.currentBet) {
        return socket.emit('errorMsg', `Chaal amount kam se kam ₹${room.currentBet} hona chahiye!`);
      }
      if (player.chips < customInput) return socket.emit('errorMsg', 'Chips kam hain!');

      player.chips -= customInput;
      room.pot += customInput;
      room.currentBet = customInput;
      room.lastMoveWasSeen = (player.state === 'seen');
      room.lastMoveAnnouncement = `${player.name} ne CHAAL chali: ₹${customInput}`;
      nextTurn(room);
    } 
    else if (type === 'BAND') {
      if (player.state !== 'blind') return socket.emit('errorMsg', 'Sirf Blind player BAND kar sakta hai!');
      if (customInput < room.currentBet) {
        return socket.emit('errorMsg', `Band amount kam se kam ₹${room.currentBet} hona chahiye!`);
      }
      if (player.chips < customInput) return socket.emit('errorMsg', 'Chips kam hain!');

      // Player pays only base amount
      player.chips -= customInput;
      room.pot += customInput;
      // Next player has to pay 2x
      room.currentBet = customInput * 2;
      room.lastMoveWasSeen = false;
      room.lastMoveAnnouncement = `⚡ ${player.name} ne BAND kiya ₹${customInput}! (Agle player ko pay karna hoga 2x: ₹${room.currentBet})`;
      nextTurn(room);
    } 
    else if (type === 'COUNTER') {
      if (player.state !== 'blind' || !room.lastMoveWasSeen) {
        return socket.emit('errorMsg', 'Counter tabhi chalega jab samne wale ne SEEN chala ho!');
      }
      if (customInput < room.currentBet) {
        return socket.emit('errorMsg', `Counter amount kam se kam ₹${room.currentBet} hona chahiye!`);
      }
      if (player.chips < customInput) return socket.emit('errorMsg', 'Chips kam hain!');

      // Player pays only base amount
      player.chips -= customInput;
      room.pot += customInput;
      // Next player has to pay 3x
      room.currentBet = customInput * 3;
      room.lastMoveWasSeen = false;
      room.lastMoveAnnouncement = `🔥 ${player.name} ne COUNTER lagaya ₹${customInput}! (Agle player ko pay karna hoga 3x: ₹${room.currentBet})`;
      nextTurn(room);
    } 
    else if (type === 'PACK') {
      player.folded = true;
      room.lastMoveAnnouncement = `${player.name} PACK / FOLD ho gaya.`;
      nextTurn(room);
    } 
    else if (type === 'SHOW') {
      let alive = room.players.filter(p => !p.folded && !p.isWaiting);
      if (alive.length > 2) return socket.emit('errorMsg', 'Show sirf 2 players bache hone par hoga!');
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

      room.lastMoveAnnouncement = `🏆 ${caller.name} ne SHOW mangwaya!`;
      finishGame(room, winner, showData);
    }
  });

  socket.on('disconnect', () => {
    for (const rId in rooms) {
      const room = rooms[rId];
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) {
        p.isOnline = false;
        if (!room.isRoundActive && room.players.length <= 1) {
          delete rooms[rId];
        } else {
          broadcastRoom(rId);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
