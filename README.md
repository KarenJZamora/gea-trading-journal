# GEA Trading Journal and MT5 bridge

## Render configuration

Create a Render Web Service from this repository:

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/healthz`

Set these environment variables in Render (and locally in `.env`):

- `MONGO_URI`: MongoDB Atlas connection string. Restrict its network access to the deployment as appropriate.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: the dashboard login; use a unique, long password.
- `MT5_API_TOKEN`: a separate long random token shared only with the MT5 Expert Advisors.
- `PORT`: Render supplies this automatically; local development may use `3000`.

The service now refuses to start if a required secret or the MongoDB URI is missing. Do not commit `.env`. The previously committed database URI and credentials must be rotated in MongoDB Atlas and replaced in Render and the local `.env`.

## MT5 setup

1. Configure the master account in the dashboard. Its `login` must exactly match the MT5 master account login.
2. Add each slave account in the dashboard, using its MT5 login and desired lot multiplier. The terminal credentials are entered and retained by MT5, not this web app.
3. Compile `mt5/GEA_Master.mq5` in MetaEditor and attach it to a chart logged into the master account.
4. Compile `mt5/GEA_Slave.mq5` and attach it to a chart on each slave account. Use the same `InpUsername`, `InpApiToken`, and Render URL; set `InpAccountLogin` to that slave login.
5. In each MT5 terminal, add `https://gea-trading-journal.onrender.com` to **Tools → Options → Expert Advisors → Allow WebRequest for listed URL**.
6. Keep both terminals and their EAs running. The master EA sends newly opened, changed, and closed positions. The slave EA polls Render and applies those changes.
7. Leave `InpEnableTrading=false` while checking the connection. First validate on demo accounts; enable it only after confirming the login, symbols, volume multiplier, and risk settings.

The slave cursor is stored in MT5 terminal global variables. Signals are retried until accepted; the EA uses a position comment to avoid repeating an already-opened position. New slave accounts start at the current signal sequence, and reactivating a paused slave skips signals from the paused period. An EA attached to the master does not backfill positions that were already open when it started. Copying is limited by the broker's symbol availability and execution rules; the EA reports rejected requests in the MT5 Experts log.

The `simulate_trades.js` helper can send test signals to a configured service. Set `MT5_API_TOKEN`, `ADMIN_USERNAME`, and `SOURCE_LOGIN` in the environment before running it.
