const crypto = require('crypto');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

try {
  require('dotenv').config();
} catch (error) {
  console.warn('No se pudo cargar .env; se usarán las variables del entorno.');
}

const requiredEnvironment = ['MONGO_URI', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'MT5_API_TOKEN'];
const missingEnvironment = requiredEnvironment.filter(name => !process.env[name]);
if (missingEnvironment.length) {
  throw new Error(`Faltan variables requeridas: ${missingEnvironment.join(', ')}`);
}

const app = express();
const server = http.createServer(app);
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sessionForToken = token => {
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
};

const getBearerToken = request => {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
};

const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    const protocols = (info.req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map(protocol => protocol.trim());
    const token = protocols[1];
    const session = protocols[0] === 'gea-auth' && token ? sessionForToken(token) : null;
    if (!session) return done(false, 401, 'Unauthorized');
    info.req.user = session.username;
    done(true);
  }
});

wss.on('connection', (socket, request) => {
  socket.username = request.user;
});

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.get('/', (request, response) => response.sendFile(path.join(__dirname, 'index.html')));

const userScoped = (request, response, next) => {
  const session = sessionForToken(getBearerToken(request));
  if (!session) return response.status(401).json({ success: false, message: 'Sesión inválida o vencida.' });
  request.user = { username: session.username };
  next();
};

const requireMt5Token = (request, response, next) => {
  const provided = getBearerToken(request);
  const expected = process.env.MT5_API_TOKEN;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return response.status(401).json({ success: false, message: 'Token MT5 inválido.' });
  }
  next();
};

const userFromRequest = request => request.user.username;
const accountView = account => {
  const plain = account.toObject();
  delete plain.password;
  return plain;
};

function broadcast(username, type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) client.send(payload);
  });
}

const masterAccountSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  login: { type: String, required: true },
  server: { type: String, required: true },
  brokerType: { type: String, default: 'MT5' },
  balance: { type: Number, default: 0 },
  equity: { type: Number, default: 0 },
  status: { type: String, default: 'Configurada' }
});
const MasterAccount = mongoose.model('MasterAccount', masterAccountSchema);

const slaveAccountSchema = new mongoose.Schema({
  username: { type: String, required: true },
  name: { type: String, required: true },
  login: { type: String, required: true },
  server: { type: String, required: true },
  suffix: { type: String, default: '' },
  multiplier: { type: Number, default: 1, min: 0.01 },
  maxDailyLoss: { type: Number, default: 500 },
  currentLossToday: { type: Number, default: 0 },
  signalCursor: { type: Number, default: 0 },
  active: { type: Boolean, default: true }
});
const SlaveAccount = mongoose.model('SlaveAccount', slaveAccountSchema);

const propFirmSchema = new mongoose.Schema({
  username: { type: String, required: true },
  firmName: { type: String, required: true },
  accountSize: { type: Number, required: true },
  cost: { type: Number, required: true },
  phase: { type: String, default: 'Fase 1' },
  payoutsReceived: { type: Number, default: 0 },
  status: { type: String, default: 'Activa' }
});
const PropFirm = mongoose.model('PropFirm', propFirmSchema);

const tradeSchema = new mongoose.Schema({
  username: { type: String, required: true },
  eventId: { type: String, sparse: true, unique: true },
  account: { type: String, default: 'Principal' },
  symbol: { type: String, required: true },
  type: { type: String, required: true, enum: ['BUY', 'SELL'] },
  lot: { type: Number, required: true, min: 0 },
  pnl: { type: Number, default: 0 },
  rMultiple: { type: Number, default: 0 },
  date: { type: String, required: true }
});
const Trade = mongoose.model('Trade', tradeSchema);

const signalSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true },
  seq: { type: Number, required: true, unique: true },
  idempotencyKey: { type: String, required: true },
  action: { type: String, required: true, enum: ['OPEN', 'UPDATE', 'CLOSE'] },
  positionId: { type: String, required: true },
  symbol: { type: String, required: true },
  type: { type: String, required: true, enum: ['BUY', 'SELL'] },
  volume: { type: Number, required: true, min: 0 },
  sl: { type: Number, default: 0 },
  tp: { type: Number, default: 0 },
  pnl: { type: Number, default: 0 }
}, { timestamps: true });
signalSchema.index({ username: 1, idempotencyKey: 1 }, { unique: true });
const Mt5Signal = mongoose.model('Mt5Signal', signalSchema);

const counterSchema = new mongoose.Schema({ _id: String, value: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);

app.get('/healthz', (request, response) => {
  response.status(mongoose.connection.readyState === 1 ? 200 : 503)
    .json({ status: mongoose.connection.readyState === 1 ? 'ok' : 'starting' });
});

app.post('/api/login', (request, response) => {
  const { username, password } = request.body || {};
  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const usernameMatches = typeof username === 'string' && username === expectedUsername;
  const supplied = Buffer.from(typeof password === 'string' ? password : '');
  const expected = Buffer.from(expectedPassword);
  const passwordMatches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (!usernameMatches || !passwordMatches) {
    return response.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username: expectedUsername, expiresAt: Date.now() + SESSION_TTL_MS });
  response.json({ success: true, token, user: { username: expectedUsername, name: expectedUsername } });
});

app.get('/api/trades/:username', userScoped, async (request, response) => {
  if (request.params.username !== userFromRequest(request)) {
    return response.status(403).json({ success: false, message: 'No autorizado.' });
  }
  try {
    const trades = await Trade.find({ username: userFromRequest(request) }).sort({ date: -1, _id: -1 });
    response.json({ success: true, trades });
  } catch (error) {
    console.error('Error obteniendo trades:', error);
    response.status(500).json({ success: false, message: 'Error obteniendo trades.' });
  }
});

app.get('/api/master-account/:username', userScoped, async (request, response) => {
  if (request.params.username !== userFromRequest(request)) {
    return response.status(403).json({ success: false, message: 'No autorizado.' });
  }
  try {
    const master = await MasterAccount.findOne({ username: userFromRequest(request) });
    response.json({ success: true, master });
  } catch (error) {
    console.error('Error obteniendo cuenta maestra:', error);
    response.status(500).json({ success: false, message: 'Error obteniendo cuenta maestra.' });
  }
});

app.post('/api/master-account', userScoped, async (request, response) => {
  const { name, login, server, brokerType, balance } = request.body || {};
  const amount = Number(balance);
  if (!name || !login || !server || !Number.isFinite(amount) || amount < 0) {
    return response.status(400).json({ success: false, message: 'Datos de cuenta maestra inválidos.' });
  }
  try {
    const master = await MasterAccount.findOneAndUpdate(
      { username: userFromRequest(request) },
      { $set: { name, login: String(login), server, brokerType: brokerType || 'MT5', balance: amount, equity: amount } },
      { upsert: true, new: true, runValidators: true }
    );
    response.json({ success: true, master });
  } catch (error) {
    console.error('Error guardando cuenta maestra:', error);
    response.status(500).json({ success: false, message: 'Error guardando cuenta maestra.' });
  }
});

app.get('/api/accounts/:username', userScoped, async (request, response) => {
  if (request.params.username !== userFromRequest(request)) {
    return response.status(403).json({ success: false, message: 'No autorizado.' });
  }
  try {
    const accounts = await SlaveAccount.find({ username: userFromRequest(request) }).select('-password');
    response.json({ success: true, accounts });
  } catch (error) {
    console.error('Error obteniendo cuentas esclavas:', error);
    response.status(500).json({ success: false, message: 'Error obteniendo cuentas esclavas.' });
  }
});

app.post('/api/accounts', userScoped, async (request, response) => {
  const { name, login, server, suffix, multiplier } = request.body || {};
  const lotMultiplier = Number(multiplier);
  if (!name || !login || !server || !Number.isFinite(lotMultiplier) || lotMultiplier <= 0) {
    return response.status(400).json({ success: false, message: 'Datos de cuenta esclava inválidos.' });
  }
  try {
    const counter = await Counter.findById('mt5-signals');
    await SlaveAccount.create({
      username: userFromRequest(request),
      name,
      login: String(login),
      server,
      suffix: suffix || '',
      multiplier: lotMultiplier,
      signalCursor: counter ? counter.value : 0
    });
    const accounts = await SlaveAccount.find({ username: userFromRequest(request) }).select('-password');
    response.json({ success: true, accounts });
  } catch (error) {
    console.error('Error creando cuenta esclava:', error);
    response.status(500).json({ success: false, message: 'Error creando cuenta esclava.' });
  }
});

app.post('/api/accounts/:id/toggle', userScoped, async (request, response) => {
  try {
    const account = await SlaveAccount.findOne({ _id: request.params.id, username: userFromRequest(request) });
    if (!account) return response.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
    account.active = !account.active;
    if (account.active) {
      const counter = await Counter.findById('mt5-signals');
      account.signalCursor = counter ? counter.value : 0;
    }
    await account.save();
    const accounts = await SlaveAccount.find({ username: userFromRequest(request) }).select('-password');
    response.json({ success: true, accounts });
  } catch (error) {
    console.error('Error actualizando cuenta esclava:', error);
    response.status(500).json({ success: false, message: 'Error actualizando estado.' });
  }
});

app.get('/api/prop-firms/:username', userScoped, async (request, response) => {
  if (request.params.username !== userFromRequest(request)) {
    return response.status(403).json({ success: false, message: 'No autorizado.' });
  }
  try {
    const firms = await PropFirm.find({ username: userFromRequest(request) });
    response.json({ success: true, firms });
  } catch (error) {
    console.error('Error obteniendo Prop Firms:', error);
    response.status(500).json({ success: false, message: 'Error obteniendo Prop Firms.' });
  }
});

app.post('/api/prop-firms', userScoped, async (request, response) => {
  const { firmName, accountSize, cost, phase } = request.body || {};
  const size = Number(accountSize);
  const fee = Number(cost);
  if (!firmName || !Number.isFinite(size) || size <= 0 || !Number.isFinite(fee) || fee < 0) {
    return response.status(400).json({ success: false, message: 'Datos de Prop Firm inválidos.' });
  }
  try {
    await PropFirm.create({
      username: userFromRequest(request),
      firmName,
      accountSize: size,
      cost: fee,
      phase: phase || 'Fase 1'
    });
    const firms = await PropFirm.find({ username: userFromRequest(request) });
    response.json({ success: true, firms });
  } catch (error) {
    console.error('Error guardando Prop Firm:', error);
    response.status(500).json({ success: false, message: 'Error guardando Prop Firm.' });
  }
});

app.post(['/api/mt5/signals', '/api/webhook/signal'], requireMt5Token, async (request, response) => {
  const payload = request.body || {};
  const username = payload.username;
  const action = payload.action;
  const positionId = String(payload.positionId || '');
  const idempotencyKey = String(payload.idempotencyKey || '');
  const volume = Number(payload.volume);
  const sl = Number(payload.sl || 0);
  const tp = Number(payload.tp || 0);
  const pnl = Number(payload.pnl || 0);
  if (
    typeof username !== 'string' || !positionId || positionId.length > 32 ||
    !idempotencyKey || idempotencyKey.length > 128 ||
    !['OPEN', 'UPDATE', 'CLOSE'].includes(action) ||
    !['BUY', 'SELL'].includes(payload.type) ||
    typeof payload.symbol !== 'string' || !payload.symbol || payload.symbol.length > 32 ||
    !Number.isFinite(volume) || volume <= 0 ||
    ![sl, tp, pnl].every(Number.isFinite)
  ) {
    return response.status(400).json({ success: false, message: 'Señal MT5 inválida.' });
  }

  try {
    const master = await MasterAccount.findOne({ username, login: String(payload.sourceLogin || '') });
    if (!master) return response.status(403).json({ success: false, message: 'Cuenta maestra no configurada para este login MT5.' });

    let signal = await Mt5Signal.findOne({ username, idempotencyKey });
    if (!signal) {
      const counter = await Counter.findOneAndUpdate(
        { _id: 'mt5-signals' },
        { $inc: { value: 1 } },
        { upsert: true, new: true }
      );
      try {
        signal = await Mt5Signal.create({
          username,
          seq: counter.value,
          idempotencyKey,
          action,
          positionId,
          symbol: payload.symbol,
          type: payload.type,
          volume,
          sl,
          tp,
          pnl
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        signal = await Mt5Signal.findOne({ username, idempotencyKey });
      }
    }

    if (action === 'CLOSE') {
      await Trade.updateOne(
        { eventId: idempotencyKey },
        {
          $setOnInsert: {
            username,
            eventId: idempotencyKey,
            account: master.name,
            symbol: payload.symbol,
            type: payload.type,
            lot: volume,
            pnl,
            date: new Date().toISOString().slice(0, 10)
          }
        },
        { upsert: true }
      );
      const trades = await Trade.find({ username }).sort({ date: -1, _id: -1 });
      broadcast(username, 'NEW_TRADE', { trades });
    }

    response.json({ success: true, seq: signal.seq });
  } catch (error) {
    console.error('Error procesando señal MT5:', error);
    response.status(500).json({ success: false, message: 'Error procesando señal MT5.' });
  }
});

app.get('/api/mt5/next', requireMt5Token, async (request, response) => {
  const username = String(request.query.username || '');
  const accountLogin = String(request.query.accountLogin || '');
  const after = Number(request.query.after || 0);
  if (!username || !accountLogin || !Number.isSafeInteger(after) || after < 0) {
    return response.status(400).json({ success: false, message: 'Parámetros MT5 inválidos.' });
  }
  try {
    const account = await SlaveAccount.findOne({ username, login: accountLogin, active: true });
    if (!account) return response.status(403).json({ success: false, message: 'Cuenta esclava no activa o no configurada.' });
    const signal = await Mt5Signal.findOne({ username, seq: { $gt: Math.max(after, account.signalCursor || 0) } }).sort({ seq: 1 });
    response.json({
      success: true,
      signal: signal ? {
        seq: signal.seq,
        action: signal.action,
        positionId: signal.positionId,
        symbol: signal.symbol,
        type: signal.type,
        volume: signal.volume,
        sl: signal.sl,
        tp: signal.tp,
        pnl: signal.pnl
      } : null,
      multiplier: account.multiplier,
      suffix: account.suffix
    });
  } catch (error) {
    console.error('Error consultando señal MT5:', error);
    response.status(500).json({ success: false, message: 'Error consultando señal MT5.' });
  }
});

app.use((error, request, response, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({ success: false, message: 'JSON inválido.' });
  }
  console.error('Error inesperado en la solicitud:', error);
  response.status(500).json({ success: false, message: 'Error interno del servidor.' });
});

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  await Promise.all([
    MasterAccount.updateMany({}, { $unset: { password: 1 } }),
    SlaveAccount.updateMany({}, { $unset: { password: 1 } })
  ]);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`[GEA Trading Journal] Servidor activo en puerto ${port}`);
  });
}

start().catch(error => {
  console.error('No se pudo iniciar el servidor:', error.message);
  process.exitCode = 1;
});
