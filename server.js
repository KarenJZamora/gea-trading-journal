const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const MONGO_URI = "mongodb://globalengineeringandanalytics_db_user:V9sokcwxty5JGonl@ac-uay28ui-shard-00-00.k452166.mongodb.net:27017,ac-uay28ui-shard-00-01.k452166.mongodb.net:27017,ac-uay28ui-shard-00-02.k452166.mongodb.net:27017/gea_copier?ssl=true&replicaSet=atlas-syduq4-shard-0&authSource=admin";

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('[JOURNAL DE TRADING] Conectado exitosamente a MongoDB Atlas');
    await User.findOneAndUpdate(
      { username: { $regex: /^Karen$/i } },
      { username: 'Karen', password: '1234', fullName: 'Karen' },
      { upsert: true, new: true }
    );
  })
  .catch(err => console.error('Error conectando a MongoDB:', err));

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const masterAccountSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String, default: 'FTMO Demo' },
  login: { type: String, required: true },
  server: { type: String, required: true },
  password: { type: String, required: true },
  brokerType: { type: String, default: 'FTMO' },
  balance: { type: Number, default: 23312.48 },
  equity: { type: Number, default: 23312.48 },
  status: { type: String, default: 'Conectada' }
});
const MasterAccount = mongoose.model('MasterAccount', masterAccountSchema);

const slaveAccountSchema = new mongoose.Schema({
  username: { type: String, required: true },
  name: { type: String, required: true },
  login: { type: String, required: true },
  server: { type: String, required: true },
  password: { type: String, required: true },
  suffix: { type: String, default: '.pro' },
  multiplier: { type: Number, default: 1.0 },
  maxDailyLoss: { type: Number, default: 500.0 },
  currentLossToday: { type: Number, default: 0.0 },
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
  account: { type: String, default: 'Principal' },
  symbol: { type: String, required: true },
  type: { type: String, required: true },
  lot: { type: Number, required: true },
  pnl: { type: Number, default: 0 },
  rMultiple: { type: Number, default: 0 },
  date: { type: String, required: true }
});
const Trade = mongoose.model('Trade', tradeSchema);

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') }, password });
    if (user) {
      res.json({ success: true, message: `¡Hola, ${user.fullName}!`, user: { username: user.username, name: user.fullName } });
    } else {
      res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error interno en el servidor.' });
  }
});

// Cuenta Maestra
app.get('/api/master-account/:username', async (req, res) => {
  try {
    let master = await MasterAccount.findOne({ username: req.params.username });
    if (!master) {
      master = await MasterAccount.create({
        username: req.params.username,
        name: 'FTMO Demo',
        login: '1515227124',
        server: 'FTMO-Demo',
        password: '',
        brokerType: 'FTMO',
        balance: 23312.48,
        equity: 23312.48
      });
    }
    res.json({ success: true, master });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error obteniendo cuenta maestra.' });
  }
});

app.post('/api/master-account', async (req, res) => {
  const { username, name, login, server, password, brokerType, balance } = req.body;
  try {
    let master = await MasterAccount.findOne({ username });
    if (master) {
      master.name = name;
      master.login = login;
      master.server = server;
      master.password = password;
      master.brokerType = brokerType;
      master.balance = parseFloat(balance) || 23312.48;
      master.equity = parseFloat(balance) || 23312.48;
      master.status = 'Conectada';
      await master.save();
    } else {
      master = await MasterAccount.create({
        username,
        name,
        login,
        server,
        password,
        brokerType,
        balance: parseFloat(balance) || 23312.48,
        equity: parseFloat(balance) || 23312.48,
        status: 'Conectada'
      });
    }
    res.json({ success: true, master });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error guardando cuenta maestra: ' + err.message });
  }
});

// Trades y Webhook
app.get('/api/trades/:username', async (req, res) => {
  try {
    const trades = await Trade.find({ username: req.params.username });
    res.json({ success: true, trades });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error obteniendo trades.' });
  }
});

app.post('/api/webhook/signal', async (req, res) => {
  const { username, account, symbol, type, lot, pnl, rMultiple } = req.body;
  try {
    await Trade.create({
      username: username || 'Karen',
      account: account || 'Principal',
      symbol,
      type,
      lot,
      pnl: pnl || 0,
      rMultiple: rMultiple || 0,
      date: new Date().toISOString().split('T')[0]
    });
    const trades = await Trade.find({ username: username || 'Karen' });
    broadcast('NEW_TRADE', { trades });
    res.json({ success: true, trades });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error procesando webhook.' });
  }
});

// Cuentas Esclavas
app.get('/api/accounts/:username', async (req, res) => {
  try {
    const accounts = await SlaveAccount.find({ username: req.params.username });
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error obteniendo cuentas esclavas.' });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    await SlaveAccount.create(req.body);
    const accounts = await SlaveAccount.find({ username: req.body.username });
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error creando cuenta esclava.' });
  }
});

app.post('/api/accounts/:id/toggle', async (req, res) => {
  try {
    const acc = await SlaveAccount.findById(req.params.id);
    if (acc) {
      acc.active = !acc.active;
      await acc.save();
      const accounts = await SlaveAccount.find({ username: acc.username });
      res.json({ success: true, accounts });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error actualizando estado.' });
  }
});

// Prop Firms
app.get('/api/prop-firms/:username', async (req, res) => {
  try {
    const firms = await PropFirm.find({ username: req.params.username });
    res.json({ success: true, firms });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error obteniendo Prop Firms.' });
  }
});

app.post('/api/prop-firms', async (req, res) => {
  try {
    await PropFirm.create(req.body);
    const firms = await PropFirm.find({ username: req.body.username });
    res.json({ success: true, firms });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error guardando Prop Firm.' });
  }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`[JOURNAL DE TRADING] Servidor activo en http://localhost:${PORT}`));