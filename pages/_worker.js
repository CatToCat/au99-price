// Cloudflare Pages advanced mode - _worker.js handles all routes.
// Data source: Shanghai Gold Exchange (SGE) www.sge.com.cn — Au99.99, CNY per gram.
//   - Intraday / live quote:  /graph/quotations
//   - Historical daily K-line: /graph/Dailyhq?instid=Au99.99
const SGE_QUOT = "https://www.sge.com.cn/graph/quotations";
const SGE_DAILY = "https://www.sge.com.cn/graph/Dailyhq?instid=Au99.99";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HDRS = { "User-Agent": UA, Referer: "https://www.sge.com.cn/", Accept: "application/json" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Historical daily K-line (for the trend chart)
    if (url.pathname === "/api/daily") {
      try {
        const data = await fetchDaily();
        const rows = (data && data.time) || [];
        const out = rows.map((x) => ({ date: x[0], close: x[2] }));
        return json({ instid: "Au99.99", points: out });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    // Intraday quote (today's chart) — full trading cycle, original order (night session 20:00 -> day session 15:30).
    // Keep every time tick so the x-axis spans the whole session; points with no value yet
    // get price=null so the chart leaves them blank (no line drawn for not-yet-reached times).
    if (url.pathname === "/api/intraday") {
      try {
        const q = await fetch(SGE_QUOT, {
          headers: HDRS,
          cf: { cacheTtl: 60, cacheEverything: true },
        }).then((r) => r.json());
        const times = q.times || [];
        const data = q.data || [];
        const out = [];
        for (let i = 0; i < times.length; i++) {
          const v = data[i];
          const hasValue = v !== "" && v != null;
          out.push({ time: times[i], price: hasValue ? Number(v) : null });
        }
        return json({ instid: q.heyue || "Au99.99", delaystr: q.delaystr || "", points: out });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    // Live price card (all data from SGE)
    if (url.pathname === "/api/price") {
      try {
        // Fetch in parallel: intraday quote + daily K-line (for previous close / change calc)
        const [q, daily] = await Promise.all([
          fetch(SGE_QUOT, { headers: HDRS, cf: { cacheTtl: 60, cacheEverything: true } }).then((r) => r.json()),
          fetchDaily(),
        ]);

        const data = (q.data || []).filter((v) => v !== "" && v != null).map(Number);
        let price = data.length ? data[data.length - 1] : null;

        // Daily K-line format: [date, open, close, low, high]. Last row = today, second-to-last = yesterday.
        const rows = (daily && daily.time) || [];
        const todayRow = rows.length ? rows[rows.length - 1] : null;
        const open = todayRow ? todayRow[1] : null;
        const low = todayRow ? todayRow[3] : null;
        const high = todayRow ? todayRow[4] : null;
        // Previous close: yesterday's close
        let preClose = null;
        if (rows.length >= 2) preClose = rows[rows.length - 2][2];
        else if (todayRow) preClose = todayRow[1];

        // Sanity check: SGE quotations sometimes returns a future/stale timestamp
        // (e.g. on weekends). The daily K-line last row is the real last trading day.
        // If the quote date is later than the last trading day, treat it as stale.
        const lastTradeDate = todayRow ? todayRow[0] : null; // "YYYY-MM-DD"
        // Convert SGE time string like "YYYY[nian]MM[yue]DD[ri] HH:mm:ss" -> "YYYY-MM-DD HH:mm:ss"
        // \u5e74=year \u6708=month \u65e5=day (CJK chars in SGE response)
        const rawTime = (q.delaystr || "").replace(/(\d+)\u5e74(\d+)\u6708(\d+)\u65e5/, "$1-$2-$3");
        const quoteDate = (rawTime.match(/^\d{4}-\d{2}-\d{2}/) || [null])[0];
        let time = rawTime;
        let stale = false;
        if (lastTradeDate && quoteDate && quoteDate > lastTradeDate) {
          // Stale/closed: fall back to last trading day's close for both price and time.
          stale = true;
          time = lastTradeDate + " (closed)";
          if (todayRow) price = todayRow[2]; // daily close
        }

        const raise = price != null && preClose != null ? +(price - preClose).toFixed(2) : null;
        const raisePercent = raise != null && preClose ? raise / preClose : null;

        return json({
          name: q.heyue || "Au99.99",
          price,
          open,
          preClose,
          high,
          low,
          raise,
          raisePercent,
          time,
          stale,
        });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    // All other paths -> static assets (index.html, echarts.min.js)
    return env.ASSETS.fetch(request);
  },
};

async function fetchDaily() {
  const r = await fetch(SGE_DAILY, { headers: HDRS, cf: { cacheTtl: 1800, cacheEverything: true } });
  return r.json();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
