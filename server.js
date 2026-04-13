/**
 * Cursed Coins — Server v2
 * Pure Node.js, no external deps required.
 * Optional: npm install nodemailer  (for real emails)
 *
 * Env vars:
 *   CC_EMAIL_USER=your@gmail.com
 *   CC_EMAIL_PASS=your_gmail_app_password
 *
 * Run: node server.js
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT    = 3000;
const DB_FILE = path.join(__dirname, 'cc_db.json');

// ── Optional nodemailer ───────────────────────────────────────────────────────
let mailer = null;
const SMTP_USER = process.env.CC_EMAIL_USER || 'amin4ik2010@gmail.com';
const SMTP_PASS = process.env.CC_EMAIL_PASS || 'burt hgvt ubys jgcg';
(function initMailer() {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log('⚠   Email creds not set → codes printed to console (dev mode)');
    return;
  }
  try {
    const nm = require('nodemailer');
    mailer = nm.createTransport({ service:'gmail', auth:{ user:SMTP_USER, pass:SMTP_PASS }});
    console.log('📧  Email enabled →', SMTP_USER);
  } catch {
    console.log('⚠   nodemailer missing → run: npm install nodemailer');
    console.log('    Codes will be printed to console.');
  }
})();

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { users:{} };
  try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch { return { users:{} }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function hashPass(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
function sanitizeUser(u) {
  if (!u) return {};
  return { coins:u.coins||0, wins:u.wins||0, losses:u.losses||0,
           frames:u.frames||[], activeFrame:u.activeFrame||'',
           avatar:u.avatar||'', email:u.email||'' };
}

// ── Shop catalogue ────────────────────────────────────────────────────────────
const SHOP_FRAMES = [
  { id:'silver',  name:'Серебряная',  price:500  },
  { id:'gold',    name:'Золотая',     price:800  },
  { id:'blood',   name:'Кровавая',    price:1000 },
  { id:'arcane',  name:'Арканная',    price:1500 },
  { id:'inferno', name:'Инферно',     price:2000 },
  { id:'void',    name:'Пустота',     price:3000 },
];

// ── In-memory ─────────────────────────────────────────────────────────────────
let sessions     = {};   // token → username
let clients      = {};   // username → { send }
let pending      = {};   // username → { code, email, expires, userData }
let rooms        = {};   // roomId → room
let playerRoom   = {};   // username → roomId
let lobby        = null; // single global lobby

// ── Cards ─────────────────────────────────────────────────────────────────────
const CARDS = ['greed','magician','skip'];
function dealCards() {
  return Array.from({length:3}, ()=> CARDS[Math.floor(Math.random()*3)]);
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }

  // index.html
  if (p==='/' || p==='/index.html') {
    const f=path.join(__dirname,'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(fs.readFileSync(f)); return;
  }

  // SSE
  if (p==='/events') {
    const token=u.searchParams.get('token');
    const uname=sessions[token];
    if (!uname) { res.writeHead(401); res.end(); return; }
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.write('retry:3000\n\n');
    const send = d => { try { res.write(`data:${d}\n\n`); } catch {} };
    clients[uname] = { send };
    req.on('close', () => { delete clients[uname]; });
    pushInitial(uname);
    return;
  }

  // API (JSON body)
  let body='';
  req.on('data', d => body+=d);
  req.on('end', () => {
    let data={};
    try { data=JSON.parse(body||'{}'); } catch {}
    route(p, data, req, res);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function jsr(res,code,obj) {
  res.writeHead(code,{'Content-Type':'application/json'});
  res.end(JSON.stringify(obj));
}
function getAuth(req) {
  const t=(req.headers['authorization']||'').replace('Bearer ','').trim();
  return sessions[t]||null;
}
function emit(uname, obj) {
  if (clients[uname]) clients[uname].send(JSON.stringify(obj));
}

// ── Routes ────────────────────────────────────────────────────────────────────
function route(p, data, req, res) {
  switch(p) {

  // Auth
  case '/api/register': return apiRegister(data,res);
  case '/api/verify':   return apiVerify(data,res);
  case '/api/resend':   return apiResend(data,res);
  case '/api/login':    return apiLogin(data,res);

  // Profile / shop
  case '/api/profile':    return apiProfile(req,res);
  case '/api/leaderboard':return apiLeaderboard(res);
  case '/api/shop/frames':return jsr(res,200,{frames:SHOP_FRAMES});
  case '/api/shop/buy':   return apiShopBuy(data,req,res);
  case '/api/shop/equip': return apiShopEquip(data,req,res);
  case '/api/avatar':     return apiAvatar(data,req,res);

  // Lobby
  case '/api/lobby/join':    return apiLobbyJoin(req,res);
  case '/api/lobby/leave':   return apiLobbyLeave(req,res);
  case '/api/lobby/ready':   return apiLobbyReady(req,res);
  case '/api/lobby/unready': return apiLobbyUnready(req,res);
  case '/api/lobby/chat':    return apiLobbyChat(data,req,res);

  // Game
  case '/api/action':     return apiAction(data,req,res);
  case '/api/nextround':  return apiNextRound(req,res);
  case '/api/game/leave': return apiGameLeave(req,res);

  default: jsr(res,404,{error:'Not found'});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
function apiRegister({username,password,email},res) {
  if (!username||!password||!email) return jsr(res,400,{error:'Заполните все поля'});
  if (username.length<3)  return jsr(res,400,{error:'Логин минимум 3 символа'});
  if (password.length<4)  return jsr(res,400,{error:'Пароль минимум 4 символа'});
  if (!email.includes('@'))return jsr(res,400,{error:'Некорректный email'});
  const db=loadDB();
  if (db.users[username]) return jsr(res,409,{error:'Логин занят'});
  if (Object.values(db.users).some(u=>u.email===email))
    return jsr(res,409,{error:'Email уже используется'});
  const code=String(Math.floor(100000+Math.random()*900000));
  pending[username]={
    code, email,
    expires: Date.now()+600000,
    userData:{ password:hashPass(password), email, coins:0, wins:0, losses:0, frames:[], activeFrame:'', avatar:'' }
  };
  sendCode(email, username, code);
  jsr(res,200,{ok:true});
}

function apiVerify({username,code},res) {
  const p=pending[username];
  if (!p) return jsr(res,400,{error:'Нет ожидающего кода'});
  if (Date.now()>p.expires) { delete pending[username]; return jsr(res,400,{error:'Код истёк'}); }
  if (p.code!==String(code)) return jsr(res,400,{error:'Неверный код'});
  const db=loadDB();
  if (db.users[username]) return jsr(res,409,{error:'Пользователь уже создан'});
  db.users[username]=p.userData;
  saveDB(db);
  delete pending[username];
  jsr(res,200,{ok:true});
}

function apiResend({username},res) {
  const p=pending[username];
  if (!p) return jsr(res,400,{error:'Нет ожидающей регистрации'});
  const code=String(Math.floor(100000+Math.random()*900000));
  p.code=code; p.expires=Date.now()+600000;
  sendCode(p.email,username,code);
  jsr(res,200,{ok:true});
}

function apiLogin({username,password},res) {
  const db=loadDB();
  const user=db.users[username];
  if (!user||user.password!==hashPass(password)) return jsr(res,401,{error:'Неверный логин или пароль'});
  const token=crypto.randomBytes(16).toString('hex');
  sessions[token]=username;
  jsr(res,200,{token,username,profile:sanitizeUser(user)});
}

function sendCode(email,username,code) {
  console.log(`📧  Code for ${username}: ${code}`);
  if (!mailer) return;
  mailer.sendMail({
    from:`"Cursed Coins" <${SMTP_USER}>`,to:email,
    subject:'🪙 Код подтверждения — Cursed Coins',
    html:`<div style="font-family:Georgia;background:#0d0a06;color:#e8d5a0;padding:32px;border-radius:8px;max-width:380px">
      <h2 style="color:#c8a84b">☽ Cursed Coins</h2>
      <p>Привет, <b>${username}</b>! Ваш код:</p>
      <div style="font-size:34px;letter-spacing:8px;color:#f0d080;text-align:center;padding:18px;border:1px solid #c8a84b44;border-radius:4px;background:#1a1208">${code}</div>
      <p style="color:#8a7a5a;font-size:12px">Действителен 10 минут.</p></div>`
  }).catch(e=>console.error('Mail error:',e.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE / SHOP
// ─────────────────────────────────────────────────────────────────────────────
function apiProfile(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  const db=loadDB();
  jsr(res,200,{profile:sanitizeUser(db.users[uname])});
}

function apiLeaderboard(res) {
  const db=loadDB();
  const board=Object.entries(db.users).map(([name,u])=>({
    username:name, wins:u.wins||0, losses:u.losses||0,
    coins:u.coins||0, avatar:u.avatar||'', activeFrame:u.activeFrame||''
  })).sort((a,b)=>b.wins-a.wins).slice(0,20);
  jsr(res,200,{board});
}

function apiShopBuy({frameId},req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  const frame=SHOP_FRAMES.find(f=>f.id===frameId);
  if (!frame) return jsr(res,400,{error:'Рамка не найдена'});
  const db=loadDB(); const user=db.users[uname];
  if (!user) return jsr(res,404,{error:'User not found'});
  if ((user.coins||0)<frame.price) return jsr(res,400,{error:'Недостаточно монет'});
  if ((user.frames||[]).includes(frameId)) return jsr(res,400,{error:'Уже куплено'});
  user.coins=(user.coins||0)-frame.price;
  user.frames=[...(user.frames||[]),frameId];
  saveDB(db);
  jsr(res,200,{ok:true,coins:user.coins,frames:user.frames});
}

function apiShopEquip({frameId},req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  const db=loadDB(); const user=db.users[uname];
  if (!user) return jsr(res,404,{error:'User not found'});
  if (frameId && !(user.frames||[]).includes(frameId)) return jsr(res,400,{error:'Не куплено'});
  user.activeFrame=frameId||'';
  saveDB(db);
  broadcastLobby();
  jsr(res,200,{ok:true,activeFrame:user.activeFrame});
}

function apiAvatar({base64},req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  if (!base64) return jsr(res,400,{error:'Нет данных'});
  if (base64.length>500000) return jsr(res,400,{error:'Файл слишком большой (макс ~375KB)'});
  const db=loadDB();
  if (!db.users[uname]) return jsr(res,404,{error:'User not found'});
  db.users[uname].avatar=base64;
  saveDB(db);
  broadcastLobby();
  jsr(res,200,{ok:true});
}

// ─────────────────────────────────────────────────────────────────────────────
// LOBBY
// ─────────────────────────────────────────────────────────────────────────────
function pubLobby() {
  if (!lobby) return null;
  const db=loadDB();
  return {
    players: lobby.players.map(p=>({
      username:p, ready:lobby.ready.includes(p),
      avatar:(db.users[p]||{}).avatar||'',
      activeFrame:(db.users[p]||{}).activeFrame||''
    })),
    chat: lobby.chat
  };
}

function broadcastLobby() {
  if (!lobby) return;
  const pl=pubLobby();
  lobby.players.forEach(p=>emit(p,{type:'lobby',lobby:pl}));
}

function apiLobbyJoin(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  // If in a game room, reject
  if (playerRoom[uname]&&rooms[playerRoom[uname]]) return jsr(res,400,{error:'Вы в игре'});
  if (!lobby) lobby={players:[],ready:[],chat:[]};
  if (!lobby.players.includes(uname)) {
    if (lobby.players.length>=3) return jsr(res,400,{error:'Лобби заполнено (макс 3 игрока)'});
    lobby.players.push(uname);
  }
  broadcastLobby();
  jsr(res,200,{ok:true,lobby:pubLobby()});
}

function apiLobbyLeave(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  if (lobby) {
    lobby.players=lobby.players.filter(p=>p!==uname);
    lobby.ready=lobby.ready.filter(p=>p!==uname);
    if (lobby.players.length===0) lobby=null;
    else broadcastLobby();
  }
  jsr(res,200,{ok:true});
}

function apiLobbyReady(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  if (!lobby||!lobby.players.includes(uname)) return jsr(res,400,{error:'Не в лобби'});
  if (!lobby.ready.includes(uname)) lobby.ready.push(uname);
  broadcastLobby();
  // Start if all ready and >=2
  if (lobby.players.length>=2 && lobby.ready.length===lobby.players.length) {
    startFromLobby();
  }
  jsr(res,200,{ok:true});
}

function apiLobbyUnready(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  if (lobby) { lobby.ready=lobby.ready.filter(p=>p!==uname); broadcastLobby(); }
  jsr(res,200,{ok:true});
}

function apiLobbyChat({text},req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  if (!lobby||!lobby.players.includes(uname)) return jsr(res,400,{error:'Не в лобби'});
  if (!text||!text.trim()) return jsr(res,400,{error:'Пустое сообщение'});
  const msg={user:uname,text:text.trim().slice(0,200),time:Date.now()};
  lobby.chat.push(msg);
  if (lobby.chat.length>100) lobby.chat=lobby.chat.slice(-100);
  broadcastLobby();
  jsr(res,200,{ok:true});
}

function startFromLobby() {
  if (!lobby) return;
  const players=[...lobby.players];
  lobby=null; // clear lobby
  const room=makeRoom(players);
  players.forEach(p=>{ playerRoom[p]=room.id; });
  broadcastRoom(room);
}

// ─────────────────────────────────────────────────────────────────────────────
// GAME
// ─────────────────────────────────────────────────────────────────────────────
function makeRoom(players) {
  const id=crypto.randomBytes(4).toString('hex');
  const n=players.length;
  const room={
    id, players,
    coins: n>=3 ? 21 : 13,
    currentTurn:0,
    hp:players.map(()=>3),
    cards:players.map(()=>dealCards()),
    phase:'playing',
    log:[],
    pendingGreed:false, greedTarget:-1, greedExtra:0,
    eliminated:[],
    roundWinner:-1,
    gameWinner:-1,
    placement:[],
  };
  rooms[id]=room;
  return room;
}

function pubRoom(room) {
  return {
    id:room.id, players:room.players, coins:room.coins,
    currentTurn:room.currentTurn, hp:room.hp, cards:room.cards,
    phase:room.phase, log:room.log.slice(-30),
    pendingGreed:room.pendingGreed, greedExtra:room.greedExtra,
    eliminated:room.eliminated,
    roundWinner:room.roundWinner, gameWinner:room.gameWinner,
    placement:room.placement
  };
}

function broadcastRoom(room) {
  room.players.forEach((p,i)=>emit(p,{type:'state',room:pubRoom(room),myIndex:i}));
}

function apiAction(data,req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  const rid=playerRoom[uname];
  if (!rid||!rooms[rid]) return jsr(res,400,{error:'Не в игре'});
  const room=rooms[rid];
  if (room.phase!=='playing') return jsr(res,400,{error:'Не идёт игра'});
  const myIdx=room.players.indexOf(uname);
  if (myIdx!==room.currentTurn) return jsr(res,400,{error:'Не ваш ход'});
  doAction(room,myIdx,data,res);
}

function doAction(room,myIdx,{action,value},res) {
  const n=room.players.length;

  if (action==='card') {
    const ci=parseInt(value);
    if (isNaN(ci)||ci<0||ci>2) return jsr(res,400,{error:'Неверный индекс карты'});
    const card=room.cards[myIdx][ci];
    if (!card) return jsr(res,400,{error:'Карта уже использована'});
    room.cards[myIdx][ci]=null;

    if (card==='greed') {
      const tgt=nextAlive(room,myIdx);
      room.pendingGreed=true; room.greedTarget=tgt; room.greedExtra=1;
      room.log.push(`🃏 ${room.players[myIdx]} → «Жадность» на ${room.players[tgt]}!`);
    } else if (card==='magician') {
      const max=n>=3?21:13;
      room.coins=Math.min(room.coins+1,max);
      room.log.push(`🎩 ${room.players[myIdx]} → «Фокусник»! Монет: ${room.coins}`);
    } else if (card==='skip') {
      const nxt=nextAlive(room,myIdx);
      room.currentTurn=nxt;
      room.log.push(`⏭ ${room.players[myIdx]} → «Пропуск»! Ход у ${room.players[nxt]}`);
    }
    broadcastRoom(room);
    return jsr(res,200,{ok:true});
  }

  if (action==='take') {
    let take=Math.max(1,Math.min(3,parseInt(value)||1));

    if (room.pendingGreed && room.greedTarget===myIdx) {
      take=Math.min(take+room.greedExtra, room.coins);
      room.log.push(`💀 Жадность! ${room.players[myIdx]} берёт лишнюю монету.`);
      room.pendingGreed=false; room.greedTarget=-1; room.greedExtra=0;
    }
    take=Math.min(take, room.coins);

    room.coins-=take;
    room.log.push(`🪙 ${room.players[myIdx]} взял ${take} мон${coinSuf(take)}. Осталось: ${room.coins}`);

    if (room.coins===0) {
      // Last coin → loser
      room.hp[myIdx]=Math.max(0,room.hp[myIdx]-1);
      room.log.push(`💥 ${room.players[myIdx]} взял последнюю! HP: ${room.hp[myIdx]}`);

      if (n===2) {
        const opp=1-myIdx;
        if (room.hp[myIdx]===0) {
          endGame(room, opp, [room.players[opp], room.players[myIdx]]);
        } else {
          room.phase='roundEnd'; room.roundWinner=opp;
        }
      } else {
        // 3-player
        if (room.hp[myIdx]===0 && !room.eliminated.includes(myIdx)) {
          room.eliminated.push(myIdx);
          room.log.push(`☠ ${room.players[myIdx]} выбыл!`);
        }
        const alive=room.players.map((_,i)=>i).filter(i=>!room.eliminated.includes(i));
        if (alive.length===1) {
          // Build placement: winner, then eliminated in reverse order (last eliminated = 2nd)
          const elim=[...room.eliminated].reverse().map(i=>room.players[i]);
          endGame(room, alive[0], [room.players[alive[0]], ...elim]);
        } else {
          // Continue with survivors, reset coins
          room.coins=21;
          room.currentTurn=nextAlive(room,myIdx);
          room.cards=room.players.map((_,i)=>room.eliminated.includes(i)?[null,null,null]:dealCards());
          room.log.push('🔄 Раунд продолжается! Монеты обновлены (выбывший игрок исключён).');
        }
      }
      broadcastRoom(room);
      return jsr(res,200,{ok:true});
    }

    room.currentTurn=nextAlive(room,myIdx);
    broadcastRoom(room);
    return jsr(res,200,{ok:true});
  }

  jsr(res,400,{error:'Неизвестное действие'});
}

function endGame(room, winnerIdx, placement) {
  room.phase='gameOver';
  room.gameWinner=winnerIdx;
  room.placement=placement;
  room.log.push(`🏆 ${room.players[winnerIdx]} победил!`);
  awardCoins(placement, room.players.length);
}

function nextAlive(room,from) {
  const n=room.players.length;
  let idx=(from+1)%n, tries=0;
  while(room.eliminated.includes(idx)&&tries<n){idx=(idx+1)%n;tries++;}
  return idx;
}

function awardCoins(placement, totalPlayers) {
  const db=loadDB();
  placement.forEach((uname,rank)=>{
    if (!db.users[uname]) return;
    const reward = totalPlayers===2
      ? (rank===0?100:0)
      : (rank===0?100:rank===1?50:0);
    db.users[uname].coins=(db.users[uname].coins||0)+reward;
    if (rank===0) db.users[uname].wins=(db.users[uname].wins||0)+1;
    else db.users[uname].losses=(db.users[uname].losses||0)+1;
  });
  saveDB(db);
}

function apiNextRound(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  const rid=playerRoom[uname];
  if (!rid||!rooms[rid]) return jsr(res,400,{error:'Не в игре'});
  const room=rooms[rid];
  if (room.phase==='roundEnd') {
    const n=room.players.length;
    room.coins=n>=3?21:13;
    room.currentTurn=room.roundWinner>=0?room.roundWinner:0;
    room.cards=room.players.map(()=>dealCards());
    room.phase='playing'; room.pendingGreed=false;
    room.greedTarget=-1; room.greedExtra=0; room.roundWinner=-1; room.log=[];
    broadcastRoom(room);
  }
  jsr(res,200,{ok:true});
}

function apiGameLeave(req,res) {
  const uname=getAuth(req);
  if (!uname) return jsr(res,401,{error:'Unauthorized'});
  const rid=playerRoom[uname];
  if (rid&&rooms[rid]) {
    const room=rooms[rid];
    room.players.forEach(p=>{
      if (p!==uname) emit(p,{type:'opponent_left',who:uname});
      delete playerRoom[p];
    });
    delete rooms[rid];
  }
  jsr(res,200,{ok:true});
}

// ── Push initial state ────────────────────────────────────────────────────────
function pushInitial(uname) {
  const rid=playerRoom[uname];
  if (rid&&rooms[rid]) {
    const room=rooms[rid];
    emit(uname,{type:'state',room:pubRoom(room),myIndex:room.players.indexOf(uname)});
    return;
  }
  if (lobby&&lobby.players.includes(uname)) {
    emit(uname,{type:'lobby',lobby:pubLobby()});
    return;
  }
  emit(uname,{type:'connected'});
}

function coinSuf(n){return n===1?'ету':n<5?'еты':'ет';}

server.listen(PORT,()=>{
  console.log(`\n🪙  Cursed Coins v2 → http://localhost:${PORT}\n`);
});
