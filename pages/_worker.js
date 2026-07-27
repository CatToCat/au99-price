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

        // Daily K-line format: [date, open, close, low, high].
        // The daily K-line only gains a row for "today" AFTER the session closes, so during
        // a live session its last row is the *previous* completed trading day.
        const rows = (daily && daily.time) || [];
        const lastKRow = rows.length ? rows[rows.length - 1] : null;
        const lastKDate = lastKRow ? lastKRow[0] : null; // "YYYY-MM-DD"

        // Determine the current Shanghai (UTC+8) date to compare against the K-line's last date.
        const nowSh = new Date(Date.now() + 8 * 3600 * 1000);
        const todaySh = nowSh.toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC+8
        // If the K-line already includes today's row, the session has closed for the day.
        const kHasToday = lastKDate === todaySh;

        let open, low, high, preClose;
        if (kHasToday) {
          // Session closed: today's row holds the final O/H/L/C; prev close = yesterday's row.
          open = lastKRow[1];
          low = lastKRow[3];
          high = lastKRow[4];
          preClose = rows.length >= 2 ? rows[rows.length - 2][2] : lastKRow[1];
        } else {
          // Live session (or pre-open): derive O/H/L from today's intraday ticks so far,
          // and use the last completed trading day's close as the previous close.
          open = data.length ? data[0] : null;
          low = data.length ? Math.min(...data) : null;
          high = data.length ? Math.max(...data) : null;
          preClose = lastKRow ? lastKRow[2] : null; // last completed trading day's close
        }

        // Staleness detection.
        // SGE's quotations feed keeps returning the *last session's* frozen data when the
        // market is closed (weekends/holidays/after-hours), sometimes with a misleading
        // timestamp. The reliable signal for "live" is whether the quote timestamp is
        // recent relative to the real current time — NOT a comparison against the daily
        // K-line date (the daily K-line only gains today's row after the session closes,
        // so on a normal trading morning it legitimately lags behind the live quote and
        // must not be treated as stale).
        const lastTradeDate = lastKDate; // last completed trading day from the daily K-line
        // Convert SGE time string like "YYYY[nian]MM[yue]DD[ri] HH:mm:ss" -> "YYYY-MM-DD HH:mm:ss"
        // \u5e74=year \u6708=month \u65e5=day (CJK chars in SGE response)
        const rawTime = (q.delaystr || "").replace(/(\d+)\u5e74(\d+)\u6708(\d+)\u65e5/, "$1-$2-$3");
        // Parse the quote timestamp as Shanghai time (UTC+8) to compare against real now.
        const m = rawTime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        let time = rawTime;
        let stale = false;
        if (m) {
          // Build epoch ms for the quote treating its wall-clock as UTC+8.
          const quoteUtcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600 * 1000;
          const ageMs = Date.now() - quoteUtcMs;
          // A live quote is at most ~15min delayed; allow generous slack. If the quote is
          // older than ~4h, the last session has ended (or it's a frozen weekend feed) → stale.
          const STALE_AFTER_MS = 4 * 3600 * 1000;
          if (ageMs > STALE_AFTER_MS) {
            stale = true;
            // Fall back to the last completed trading day's close.
            time = (lastTradeDate || rawTime.slice(0, 10)) + " (closed)";
            if (lastKRow) price = lastKRow[2]; // daily close
          }
        } else if (!rawTime) {
          stale = true;
          if (lastTradeDate) time = lastTradeDate + " (closed)";
          if (lastKRow) price = lastKRow[2];
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
