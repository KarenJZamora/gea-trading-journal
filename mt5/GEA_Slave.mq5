#property strict

#include <Trade/Trade.mqh>

input string InpBaseUrl = "https://gea-trading-journal.onrender.com";
input string InpApiToken = "";
input string InpUsername = "";
input ulong InpAccountLogin = 0;
input int InpPollSeconds = 2;
input ulong InpMagicNumber = 50261115;
input bool InpEnableTrading = false;

CTrade trade;
string cursorName;

string ReadJsonField(const string json, const string key)
{
   string marker = "\"" + key + "\"";
   int start = StringFind(json, marker);
   if(start < 0)
      return "";
   start = StringFind(json, ":", start + StringLen(marker));
   if(start < 0)
      return "";
   start++;
   while(start < StringLen(json) && (StringGetCharacter(json, start) == ' ' || StringGetCharacter(json, start) == '\t'))
      start++;
   if(start >= StringLen(json) || StringGetCharacter(json, start) == 'n')
      return "";

   if(StringGetCharacter(json, start) == '"')
   {
      int end = StringFind(json, "\"", start + 1);
      return end < 0 ? "" : StringSubstr(json, start + 1, end - start - 1);
   }

   int end = start;
   while(end < StringLen(json) &&
         StringGetCharacter(json, end) != ',' &&
         StringGetCharacter(json, end) != '}' &&
         StringGetCharacter(json, end) != ' ' &&
         StringGetCharacter(json, end) != '\r' &&
         StringGetCharacter(json, end) != '\n')
      end++;
   return StringSubstr(json, start, end - start);
}

bool GetNextSignal(const long after, string &json)
{
   string url = StringFormat("%s/api/mt5/next?username=%s&accountLogin=%I64u&after=%I64d",
                             InpBaseUrl, InpUsername, InpAccountLogin, after);
   char request[];
   char result[];
   string resultHeaders;
   string headers = "Authorization: Bearer " + InpApiToken + "\r\n";
   int status = WebRequest("GET", url, headers, 10000, request, result, resultHeaders);
   if(status != 200)
   {
      PrintFormat("Error consultando señales MT5. HTTP=%d, error=%d", status, GetLastError());
      return false;
   }
   json = CharArrayToString(result, 0, -1, CP_UTF8);
   return true;
}

double NormalizedVolume(const string symbol, const double requested)
{
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double minimum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maximum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0.0 || requested <= 0.0)
      return 0.0;

   double volume = MathFloor(requested / step + 0.00000001) * step;
   if(volume < minimum)
      return 0.0;
   return MathMin(volume, maximum);
}

string PositionComment(const string sourcePositionId)
{
   return "GEA_" + sourcePositionId;
}

bool HasCopiedPosition(const string comment)
{
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionSelectByTicket(ticket) &&
         StringFind(PositionGetString(POSITION_COMMENT), comment) == 0)
         return true;
   }
   return false;
}

bool ApplySignal(const string json, const double multiplier, const string suffix)
{
   string action = ReadJsonField(json, "action");
   string sourcePositionId = ReadJsonField(json, "positionId");
   string sourceSymbol = ReadJsonField(json, "symbol");
   string type = ReadJsonField(json, "type");
   string comment = PositionComment(sourcePositionId);
   double sourceVolume = StringToDouble(ReadJsonField(json, "volume"));
   double sl = StringToDouble(ReadJsonField(json, "sl"));
   double tp = StringToDouble(ReadJsonField(json, "tp"));
   string symbol = sourceSymbol;

   if(sourcePositionId == "" || sourceSymbol == "" || multiplier <= 0.0)
      return false;
   if(!SymbolSelect(symbol, true) && suffix != "")
      symbol = sourceSymbol + suffix;
   if(!SymbolSelect(symbol, true))
   {
      PrintFormat("Símbolo no disponible en cuenta esclava: %s", sourceSymbol);
      return false;
   }

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetTypeFillingBySymbol(symbol);

   if(action == "OPEN")
   {
      if(HasCopiedPosition(comment))
         return true;
      double volume = NormalizedVolume(symbol, sourceVolume * multiplier);
      if(volume <= 0.0)
      {
         PrintFormat("Volumen calculado fuera de los límites del broker: %s %.4f", symbol, sourceVolume * multiplier);
         return false;
      }
      bool sent = type == "BUY"
         ? trade.Buy(volume, symbol, 0.0, sl, tp, comment)
         : trade.Sell(volume, symbol, 0.0, sl, tp, comment);
      if(!sent || (trade.ResultRetcode() != TRADE_RETCODE_DONE &&
                   trade.ResultRetcode() != TRADE_RETCODE_DONE_PARTIAL &&
                   trade.ResultRetcode() != TRADE_RETCODE_PLACED))
      {
         PrintFormat("Falló la apertura de %s. Código MT5=%u", symbol, trade.ResultRetcode());
         return false;
      }
      return true;
   }

   if(action == "UPDATE")
   {
      bool found = false;
      bool updated = true;
      double currentVolume = 0.0;
      for(int i = 0; i < PositionsTotal(); i++)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0 || !PositionSelectByTicket(ticket) ||
            StringFind(PositionGetString(POSITION_COMMENT), comment) != 0)
            continue;
         found = true;
         currentVolume += PositionGetDouble(POSITION_VOLUME);
      }
      if(!found)
         return true;

      double targetVolume = NormalizedVolume(symbol, sourceVolume * multiplier);
      double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
      if(targetVolume <= 0.0 || step <= 0.0)
         return false;

      if(currentVolume > targetVolume + step / 2.0)
      {
         double remaining = currentVolume - targetVolume;
         for(int i = PositionsTotal() - 1; i >= 0 && remaining > step / 2.0; i--)
         {
            ulong ticket = PositionGetTicket(i);
            if(ticket == 0 || !PositionSelectByTicket(ticket) ||
               StringFind(PositionGetString(POSITION_COMMENT), comment) != 0)
               continue;
            double positionVolume = PositionGetDouble(POSITION_VOLUME);
            double closeVolume = MathMin(remaining, positionVolume);
            bool closed = closeVolume >= positionVolume - step / 2.0
               ? trade.PositionClose(ticket)
               : trade.PositionClosePartial(ticket, closeVolume);
            if(!closed)
               updated = false;
            else
               remaining -= closeVolume;
         }
         if(remaining > step / 2.0)
            return false;
      }
      else if(currentVolume < targetVolume - step / 2.0)
      {
         double addVolume = NormalizedVolume(symbol, targetVolume - currentVolume);
         bool sent = type == "BUY"
            ? trade.Buy(addVolume, symbol, 0.0, sl, tp, comment)
            : trade.Sell(addVolume, symbol, 0.0, sl, tp, comment);
         if(!sent)
            return false;
      }

      for(int i = 0; i < PositionsTotal(); i++)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0 && PositionSelectByTicket(ticket) &&
            StringFind(PositionGetString(POSITION_COMMENT), comment) == 0 &&
            !trade.PositionModify(ticket, sl, tp))
            updated = false;
      }
      return updated;
   }

   if(action == "CLOSE")
   {
      bool closed = true;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0 || !PositionSelectByTicket(ticket) ||
            StringFind(PositionGetString(POSITION_COMMENT), comment) != 0)
            continue;
         if(!trade.PositionClose(ticket))
            closed = false;
      }
      return closed;
   }

   PrintFormat("Acción MT5 desconocida: %s", action);
   return false;
}

int OnInit()
{
   if(InpPollSeconds < 1 || InpApiToken == "" || InpUsername == "" || InpAccountLogin == 0)
      return INIT_PARAMETERS_INCORRECT;
   if(AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
   {
      Print("El EA esclavo requiere una cuenta MT5 hedging para mapear cada posición copiada.");
      return INIT_FAILED;
   }

   cursorName = StringFormat("GEA_%I64u", InpAccountLogin);
   if(!GlobalVariableCheck(cursorName))
      GlobalVariableSet(cursorName, 0.0);
   trade.SetExpertMagicNumber(InpMagicNumber);
   EventSetTimer(InpPollSeconds);
   PrintFormat("EA esclavo listo para la cuenta %I64u. Trading habilitado: %s",
               InpAccountLogin, InpEnableTrading ? "sí" : "no");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   string response;
   long after = (long)GlobalVariableGet(cursorName);
   if(!GetNextSignal(after, response))
      return;

   string signal = ReadJsonField(response, "signal");
   if(signal == "")
      return;

   long seq = (long)StringToInteger(ReadJsonField(response, "seq"));
   double multiplier = StringToDouble(ReadJsonField(response, "multiplier"));
   string suffix = ReadJsonField(response, "suffix");
   if(seq <= after)
      return;
   if(!InpEnableTrading)
   {
      Print("Hay una señal pendiente; activa InpEnableTrading tras probar en demo.");
      return;
   }
   if(ApplySignal(response, multiplier, suffix))
      GlobalVariableSet(cursorName, (double)seq);
}
