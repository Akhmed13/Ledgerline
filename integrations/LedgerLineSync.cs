#region Using declarations
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
#endregion

// Ledger Line live sync for NinjaTrader 8.
// Sends every fill on your trading accounts to your Ledger Line journal as it happens.
// Install: put this file in Documents\NinjaTrader 8\bin\Custom\AddOns\, then open
// New → NinjaScript Editor and press F5 (compile). It starts by itself whenever NinjaTrader is open.
// Messages appear in New → NinjaScript Output.
namespace NinjaTrader.NinjaScript.AddOns
{
	public class LedgerLineSync : AddOnBase
	{
		// ---- your settings (filled in by Ledger Line when you download this file) ----
		private const string SyncUrl = "{{URL}}";
		private const string SyncKey = "{{KEY}}";
		// Account names to sync, separated by commas. Leave empty to sync every account except Sim/Playback.
		private const string OnlyAccounts = "";
		// ------------------------------------------------------------------------------

		private static readonly object Gate = new object();
		private static LedgerLineSync owner;
		private static readonly HashSet<string> Hooked = new HashSet<string>();
		private static readonly List<Account> HookedAccounts = new List<Account>();
		private static readonly Dictionary<string, string> Queue = new Dictionary<string, string>();
		private static readonly HashSet<string> Sent = new HashSet<string>();
		private static System.Threading.Timer timer;
		private static int busy;
		private static DateTime lastPing = DateTime.MinValue;
		private static bool keyRejected;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Name = "LedgerLineSync";
				Description = "Sends your fills to your Ledger Line journal.";
			}
			else if (State == State.Configure || State == State.Active)
			{
				lock (Gate)
				{
					if (owner != null) return;
					owner = this;
				}
				try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch { }
				Account.AccountStatusUpdate += OnAccountStatus;
				List<Account> all;
				lock (Account.All) all = Account.All.ToList();
				foreach (Account a in all) Hook(a);
				timer = new System.Threading.Timer(_ => Flush(), null, 3000, 10000);
				Say("started. Sending fills to " + SyncUrl);
			}
			else if (State == State.Terminated)
			{
				lock (Gate)
				{
					if (owner != this) return;
					owner = null;
				}
				Account.AccountStatusUpdate -= OnAccountStatus;
				lock (Gate)
				{
					foreach (Account a in HookedAccounts) a.ExecutionUpdate -= OnExecution;
					HookedAccounts.Clear();
					Hooked.Clear();
				}
				if (timer != null) { timer.Dispose(); timer = null; }
				Flush();
			}
		}

		private static bool Wanted(Account a)
		{
			if (a == null || string.IsNullOrEmpty(a.Name)) return false;
			if (!string.IsNullOrWhiteSpace(OnlyAccounts))
				return OnlyAccounts.Split(',').Any(n => string.Equals(n.Trim(), a.Name, StringComparison.OrdinalIgnoreCase));
			string n2 = a.Name.ToLowerInvariant();
			return !(n2.StartsWith("sim") || n2.StartsWith("playback") || n2.StartsWith("backtest"));
		}

		private void Hook(Account a)
		{
			if (!Wanted(a)) return;
			lock (Gate)
			{
				if (Hooked.Contains(a.Name)) return;
				Hooked.Add(a.Name);
				HookedAccounts.Add(a);
			}
			a.ExecutionUpdate += OnExecution;
			List<Execution> past;
			lock (a.Executions) past = a.Executions.ToList();
			foreach (Execution x in past) Add(x);
			Say("watching account " + a.Name + (past.Count > 0 ? " (" + past.Count + " fills from this session)" : ""));
		}

		private void OnAccountStatus(object sender, AccountStatusEventArgs e)
		{
			if (e.Status == ConnectionStatus.Connected && e.Account != null) Hook(e.Account);
		}

		private static void OnExecution(object sender, ExecutionEventArgs e)
		{
			if (e.Execution != null) Add(e.Execution);
		}

		private static string Num(double v) { return v.ToString("0.##########", CultureInfo.InvariantCulture); }
		private static string Str(string s)
		{
			if (s == null) return "\"\"";
			var b = new StringBuilder("\"");
			foreach (char c in s)
			{
				if (c == '"' || c == '\\') b.Append('\\').Append(c);
				else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
				else b.Append(c);
			}
			return b.Append('"').ToString();
		}

		private static void Add(Execution x)
		{
			try
			{
				if (x == null || x.Instrument == null || x.Account == null || x.Quantity == 0) return;
				var mi = x.Instrument.MasterInstrument;
				string json = "{"
					+ "\"id\":" + Str(x.ExecutionId)
					+ ",\"orderId\":" + Str(x.OrderId)
					+ ",\"account\":" + Str(x.Account.Name)
					+ ",\"instrument\":" + Str(x.Instrument.FullName)
					+ ",\"root\":" + Str(mi.Name)
					+ ",\"side\":" + Str(x.MarketPosition == MarketPosition.Long ? "Buy" : "Sell")
					+ ",\"qty\":" + x.Quantity.ToString(CultureInfo.InvariantCulture)
					+ ",\"price\":" + Num(x.Price)
					+ ",\"time\":" + Str(x.Time.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture))
					+ ",\"commission\":" + Num(x.Commission)
					+ ",\"pointValue\":" + Num(mi.PointValue)
					+ ",\"tickSize\":" + Num(mi.TickSize)
					+ "}";
				string key = x.Account.Name + "|" + x.ExecutionId + "|" + x.Quantity + "|" + Num(x.Price);
				lock (Gate)
				{
					if (Sent.Contains(key)) return;
					Queue[key] = json;
				}
			}
			catch (Exception ex) { Say("couldn't read a fill: " + ex.Message); }
		}

		private static void Flush()
		{
			if (Interlocked.Exchange(ref busy, 1) == 1) return;
			try
			{
				List<KeyValuePair<string, string>> batch;
				string[] names;
				lock (Gate)
				{
					batch = Queue.Take(300).ToList();
					names = Hooked.ToArray();
				}
				bool ping = (DateTime.Now - lastPing).TotalMinutes >= 5;
				if (batch.Count == 0 && !ping) return;
				if (keyRejected && batch.Count == 0) return;
				string body = "{\"client\":\"NinjaTrader 8\",\"accounts\":[" + string.Join(",", names.Select(Str))
					+ "],\"executions\":[" + string.Join(",", batch.Select(p => p.Value)) + "]}";
				using (var wc = new WebClient())
				{
					wc.Encoding = Encoding.UTF8;
					wc.Headers[HttpRequestHeader.ContentType] = "application/json";
					wc.Headers["x-ledgerline-sync"] = SyncKey;
					wc.UploadString(SyncUrl, "POST", body);
				}
				lastPing = DateTime.Now;
				keyRejected = false;
				lock (Gate)
				{
					foreach (var p in batch) { Queue.Remove(p.Key); Sent.Add(p.Key); }
				}
				if (batch.Count > 0) Say("sent " + batch.Count + " fill(s)");
			}
			catch (WebException we)
			{
				var r = we.Response as HttpWebResponse;
				if (r != null && r.StatusCode == HttpStatusCode.Unauthorized)
				{
					if (!keyRejected) Say("the sync key was rejected. Download the add-on again from Ledger Line → Settings → Accounts.");
					keyRejected = true;
				}
				else Say("couldn't reach Ledger Line (" + we.Message + "). Will retry.");
				lastPing = DateTime.Now;
			}
			catch (Exception ex) { Say("error: " + ex.Message); }
			finally { Interlocked.Exchange(ref busy, 0); }
		}

		private static void Say(string m)
		{
			try { NinjaTrader.Code.Output.Process("Ledger Line: " + m, PrintTo.OutputTab1); } catch { }
		}
	}
}
