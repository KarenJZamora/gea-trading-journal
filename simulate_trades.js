const http = require('http');

const symbols = ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY', 'NAS100'];
const types = ['BUY', 'SELL'];

function sendMockTrade() {
  const symbol = symbols[Math.floor(Math.random() * symbols.length)];
  const type = types[Math.floor(Math.random() * types.length)];
  const masterLot = (Math.random() * 1.5 + 0.1).toFixed(2);
  const price = symbol === 'XAUUSD' ? (2300 + Math.random() * 50).toFixed(2) : (1.0500 + Math.random() * 0.05).toFixed(5);

  const payload = JSON.stringify({
    ticket: `#${Math.floor(9000000 + Math.random() * 900000)}`,
    symbol: symbol,
    type: type,
    masterLot: masterLot,
    price: price,
    slippagePips: parseFloat((Math.random() * 0.8).toFixed(1))
  });

  const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/trade-signal',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length
    }
  });

  req.on('error', (err) => console.error('Error al emitir señal:', err.message));
  req.write(payload);
  req.end();
}

console.log('[SIMULADOR] Emitiendo operaciones cada 4 segundos...');
setInterval(sendMockTrade, 4000);