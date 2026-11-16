const symbols = ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY', 'NAS100'];
const types = ['BUY', 'SELL'];
const baseUrl = process.env.RENDER_URL || 'http://localhost:3000';
const token = process.env.MT5_API_TOKEN;
const username = process.env.ADMIN_USERNAME;
const sourceLogin = process.env.SOURCE_LOGIN;
let nextPositionId = 1;

if (!token || !username || !sourceLogin) {
  throw new Error('Configura MT5_API_TOKEN, ADMIN_USERNAME y SOURCE_LOGIN.');
}

async function sendMockTrade() {
  const symbol = symbols[Math.floor(Math.random() * symbols.length)];
  const type = types[Math.floor(Math.random() * types.length)];
  const positionId = `sim-${nextPositionId++}`;
  const payload = {
    username,
    sourceLogin,
    idempotencyKey: `${positionId}-OPEN`,
    action: 'OPEN',
    positionId,
    symbol,
    type,
    volume: Number((Math.random() * 1.5 + 0.1).toFixed(2)),
    sl: 0,
    tp: 0,
    pnl: 0
  };

  try {
    const response = await fetch(`${baseUrl}/api/mt5/signals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    console.log(`[SIMULADOR] Señal enviada para ${symbol} (${positionId}).`);
  } catch (error) {
    console.error('Error al emitir señal:', error.message);
  }
}

console.log('[SIMULADOR] Emitiendo operaciones cada 4 segundos...');
setInterval(sendMockTrade, 4000);