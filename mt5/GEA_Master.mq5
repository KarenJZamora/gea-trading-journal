#property strict

input string InpBaseUrl = "https://gea-trading-journal.onrender.com";
input string InpApiToken = "";
input string InpUsername = "";
input int InpScanSeconds = 1;

struct PositionSnapshot
{
   ulong id;
   string symbol;
   string type;
   double volume;
   double sl;
   double tp;
};

PositionSnapshot tracked[];

string JsonEscape(const string value)
{
   string escaped = value;
   StringReplace(escaped, "\\", "\\\\");
   StringReplace(escaped, "\"", "\\\"");
   return escaped;
}

int FindSnapshot(PositionSnapshot &snapshots[], const ulong id)
{
   for(int i = 0; i < ArraySize(snapshots); i++)
      if(snapshots[i].id == id)
         return i;
   return -1;
}

void AddSnapshot(PositionSnapshot &snapshots[], const PositionSnapshot &snapshot)
{
   int size = ArraySize(snapshots);
   ArrayResize(snapshots, size + 1);
   snapshots[size] = snapshot;
}

bool SamePosition(const PositionSnapshot &left, const PositionSnapshot &right)
{
   double step = SymbolInfoDouble(left.symbol, SYMBOL_VOLUME_STEP);
   double priceStep = SymbolInfoDouble(left.symbol, SYMBOL_POINT);
   return left.symbol == right.symbol &&
          MathAbs(left.volume - right.volume) < MathMax(step / 2.0, 0.0000001) &&
          MathAbs(left.sl - right.sl) < MathMax(priceStep / 2.0, 0.0000001) &&
          MathAbs(left.tp - right.tp) < MathMax(priceStep / 2.0, 0.0000001);
}

double ClosedPositionPnl(const ulong positionId)
{
   if(!HistorySelectByPosition(positionId))
      return 0.0;

   double pnl = 0.0;
   for(int i = 0; i < HistoryDealsTotal(); i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0)
         continue;
      pnl += HistoryDealGetDouble(deal, DEAL_PROFIT);
      pnl += HistoryDealGetDouble(deal, DEAL_SWAP);
      pnl += HistoryDealGetDouble(deal, DEAL_COMMISSION);
   }
   return pnl;
}

bool SendSignal(const string action, const PositionSnapshot &position, const double pnl = 0.0)
{
   if(InpApiToken == "" || InpUsername == "")
   {
      Print("Configura InpApiToken e InpUsername antes de conectar el EA maestro.");
      return false;
   }

   long sourceLogin = AccountInfoInteger(ACCOUNT_LOGIN);
   string key = StringFormat("%I64d-%I64u-%s-%.8f-%.8f-%.8f",
                             sourceLogin, position.id, action, position.volume, position.sl, position.tp);
   string body = StringFormat(
      "{\"username\":\"%s\",\"sourceLogin\":\"%I64d\",\"idempotencyKey\":\"%s\","
      "\"action\":\"%s\",\"positionId\":\"%I64u\",\"symbol\":\"%s\","
      "\"type\":\"%s\",\"volume\":%.8f,\"sl\":%.10f,\"tp\":%.10f,\"pnl\":%.2f}",
      JsonEscape(InpUsername), sourceLogin, key, action, position.id,
      JsonEscape(position.symbol), position.type, position.volume, position.sl, position.tp, pnl
   );

   char data[];
   char result[];
   string resultHeaders;
   int bytes = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(bytes > 0)
      ArrayResize(data, bytes - 1);
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + InpApiToken + "\r\n";
   int status = WebRequest("POST", InpBaseUrl + "/api/mt5/signals", headers, 10000, data, result, resultHeaders);
   if(status != 200)
   {
      PrintFormat("No se pudo enviar %s para posición %I64u. HTTP=%d, error=%d",
                  action, position.id, status, GetLastError());
      return false;
   }
   return true;
}

void ReadOpenPositions(PositionSnapshot &current[])
{
   ArrayResize(current, 0);
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;

      PositionSnapshot position;
      position.id = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
      position.symbol = PositionGetString(POSITION_SYMBOL);
      position.type = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL";
      position.volume = PositionGetDouble(POSITION_VOLUME);
      position.sl = PositionGetDouble(POSITION_SL);
      position.tp = PositionGetDouble(POSITION_TP);
      AddSnapshot(current, position);
   }
}

int OnInit()
{
   if(InpScanSeconds < 1)
      return INIT_PARAMETERS_INCORRECT;

   ReadOpenPositions(tracked);
   EventSetTimer(InpScanSeconds);
   Print("EA maestro activo. Solo enviará cambios posteriores a su inicio.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   PositionSnapshot current[];
   PositionSnapshot next[];
   ReadOpenPositions(current);

   for(int i = 0; i < ArraySize(current); i++)
   {
      int previous = FindSnapshot(tracked, current[i].id);
      if(previous < 0)
      {
         if(SendSignal("OPEN", current[i]))
            AddSnapshot(next, current[i]);
      }
      else if(!SamePosition(tracked[previous], current[i]))
      {
         if(SendSignal("UPDATE", current[i]))
            AddSnapshot(next, current[i]);
         else
            AddSnapshot(next, tracked[previous]);
      }
      else
      {
         AddSnapshot(next, current[i]);
      }
   }

   for(int i = 0; i < ArraySize(tracked); i++)
   {
      if(FindSnapshot(current, tracked[i].id) >= 0)
         continue;
      if(!SendSignal("CLOSE", tracked[i], ClosedPositionPnl(tracked[i].id)))
         AddSnapshot(next, tracked[i]);
   }

   ArrayResize(tracked, ArraySize(next));
   for(int i = 0; i < ArraySize(next); i++)
      tracked[i] = next[i];
}
