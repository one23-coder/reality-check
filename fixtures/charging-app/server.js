// 充电桩预约 — 第三个被测应用，故意与 booking-app / exam-seat-app **不同域、不同
// schema、不同观察器命名**，用来证明「接入新应用 = 写配置」，而不是改适配器源码：
//   · 表：stations / reservations / queue / accounts（没有 courses / bookings / exams）
//   · 口径：ports-free（余位）/ reservation-count / queue-head / holder-account
//   · 语义：预约占用一个「桩口」，满了进队列，释放时把队首递补进来
//
// 应用契约（适配器侧，见 docs/adapter-tutorial.md）：
//   · RC_PORT / RC_DB / RC_SEED / RC_FAULT 环境变量
//   · GET /healthz → {ok, app, version}
//   · GET /register /login，表单含 #username / #password 与 button[type=submit]
//   · 每个页面以 <div id="result" data-result="...">…</div> 结尾（适配器据 data-result
//     与文案判定 rejected；"waitlisted" 不是拒绝）
//   · 表单 action 用绝对 URL；node:sqlite + WAL
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.RC_PORT ?? 3000);
const DB_PATH = process.env.RC_DB ?? ":memory:";
const FAULT = process.env.RC_FAULT ?? "";
const STATION_ID = "st-1";
const STATION_PORTS = 2;

let seedAccounts = [];
try {
  seedAccounts = JSON.parse(process.env.RC_SEED ?? "[]");
  if (!Array.isArray(seedAccounts)) seedAccounts = [];
} catch {
  seedAccounts = [];
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ports INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  account TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  account TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  seed_role TEXT NOT NULL DEFAULT 'none'
);
`);

db.prepare("INSERT OR IGNORE INTO stations (id, label, ports) VALUES (?, ?, ?)").run(
  STATION_ID,
  "南门快充站",
  STATION_PORTS,
);

// 种子账号（规则 7 的应用侧兑现）：seedRole "holder" 占一个桩口，"waitlisted" 直接
// 排进队列初始位置；"none" 什么都不做。
for (const s of seedAccounts) {
  if (!s || typeof s.username !== "string" || typeof s.password !== "string") continue;
  const seedRole = typeof s.seedRole === "string" ? s.seedRole : "none";
  db.prepare("INSERT OR IGNORE INTO accounts (username, password, seed_role) VALUES (?, ?, ?)").run(
    s.username,
    s.password,
    seedRole,
  );
  if (seedRole === "holder") {
    const existing = db
      .prepare("SELECT id FROM reservations WHERE station_id = ? AND account = ?")
      .get(STATION_ID, s.username);
    if (!existing) {
      db.prepare("INSERT INTO reservations (station_id, account, created_at) VALUES (?, ?, ?)").run(
        STATION_ID,
        s.username,
        new Date().toISOString(),
      );
    }
  } else if (seedRole === "waitlisted") {
    const existing = db
      .prepare("SELECT id FROM queue WHERE station_id = ? AND account = ?")
      .get(STATION_ID, s.username);
    if (!existing) {
      const pos = db
        .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM queue WHERE station_id = ?")
        .get(STATION_ID).p;
      db.prepare("INSERT INTO queue (station_id, account, position) VALUES (?, ?, ?)").run(
        STATION_ID,
        s.username,
        pos,
      );
    }
  }
}

// ------------------------------------------------------------------ sessions

const sessions = new Map(); // token -> username

function currentUser(req) {
  const cookie = req.headers.cookie ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "ca_session") {
      const username = sessions.get(rest.join("="));
      if (username) return username;
    }
  }
  return null;
}

// -------------------------------------------------------------------- html

function abs(req, p) {
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  return `http://${host}${p}`;
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 每个页面以 <div id="result" data-result="...">…</div> 结尾。 */
function render(res, title, body, result = { code: "ok", text: "" }, status = 200) {
  sendHtml(
    res,
    status,
    `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
${body}
<div id="result" data-result="${result.code}">${result.text}</div>
</body>
</html>`,
  );
}

function registerForm(req) {
  return `<form method="POST" action="${abs(req, "/register")}">
<label>用户名 <input id="username" name="username" type="text"></label><br>
<label>密码 <input id="password" name="password" type="password"></label><br>
<button type="submit">注册</button>
</form>`;
}

function loginForm(req) {
  return `<form method="POST" action="${abs(req, "/login")}">
<label>用户名 <input id="username" name="username" type="text"></label><br>
<label>密码 <input id="password" name="password" type="password"></label><br>
<button type="submit">登录</button>
</form>`;
}

function homeBody(req) {
  const user = currentUser(req);
  const who = user ? `<p>当前用户：${user}</p>` : `<p>未登录</p>`;
  const nav = `<p><a href="${abs(req, "/register")}">注册</a> | <a href="${abs(req, "/login")}">登录</a></p>`;
  const rows = db
    .prepare(
      `SELECT s.id, s.label, s.ports,
              (SELECT COUNT(*) FROM reservations r WHERE r.station_id = s.id) AS taken
       FROM stations s ORDER BY s.id`,
    )
    .all()
    .map((s) => {
      const free = s.ports - s.taken;
      return `<li>${s.label} (${s.id}) — 桩口 ${s.ports}，占用 ${s.taken}，空闲 ${free} — <a href="${abs(req, `/reserve?station=${s.id}`)}">预约</a> | <a href="${abs(req, `/release?station=${s.id}`)}">结束充电</a></li>`;
    })
    .join("\n");
  return `${nav}${who}<ul>\n${rows}\n</ul>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))));
  });
}

// ------------------------------------------------------------------ routing

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", abs(req, "/"));
  const p = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  if (p === "/healthz") {
    return sendJson(res, 200, { ok: true, app: "charging-app", version: "0.1.0" });
  }

  if (p === "/" && method === "GET") {
    return render(res, "充电桩预约", homeBody(req));
  }

  if (p === "/register") {
    if (method === "GET") return render(res, "注册", registerForm(req));
    const form = await readBody(req);
    const { username, password } = form;
    if (!username || !password) {
      return render(res, "注册", registerForm(req), {
        code: "rejected",
        text: "用户名和密码不能为空",
      });
    }
    const existing = db.prepare("SELECT password FROM accounts WHERE username = ?").get(username);
    if (existing) {
      if (existing.password === password) {
        return render(res, "注册", registerForm(req), {
          code: "ok",
          text: `账号已存在，密码匹配（${username}）`,
        });
      }
      return render(res, "注册", registerForm(req), { code: "rejected", text: "用户名已被占用" }, 409);
    }
    db.prepare("INSERT INTO accounts (username, password, seed_role) VALUES (?, ?, 'none')").run(
      username,
      password,
    );
    return render(res, "注册", registerForm(req), { code: "ok", text: `注册成功（${username}）` });
  }

  if (p === "/login") {
    if (method === "GET") return render(res, "登录", loginForm(req));
    const form = await readBody(req);
    const row = db
      .prepare("SELECT password FROM accounts WHERE username = ?")
      .get(form.username ?? "");
    if (!row || row.password !== form.password) {
      return render(res, "登录", loginForm(req), { code: "rejected", text: "用户名或密码错误" });
    }
    const token = randomUUID();
    sessions.set(token, String(form.username));
    res.setHeader("set-cookie", `ca_session=${token}; Path=/`);
    return render(res, "登录", loginForm(req), { code: "ok", text: `登录成功（${form.username}）` });
  }

  if (p === "/reserve" && method === "GET") {
    const stationId = url.searchParams.get("station") ?? STATION_ID;
    const station = db.prepare("SELECT id, label FROM stations WHERE id = ?").get(stationId);
    if (!station) return render(res, "预约", "", { code: "rejected", text: "充电站不存在" }, 404);
    const body = `<form method="POST" action="${abs(req, "/reserve")}">
<input type="hidden" name="station" value="${station.id}">
<button type="submit">确认预约 ${station.label}</button>
</form>`;
    return render(res, "预约", body);
  }

  if (p === "/reserve" && method === "POST") {
    const form = await readBody(req);
    const stationId = form.station ?? STATION_ID;
    const user = currentUser(req);
    if (!user) {
      return render(res, "预约", "", { code: "rejected", text: "请先登录后再预约" }, 401);
    }
    const station = db.prepare("SELECT id, ports FROM stations WHERE id = ?").get(stationId);
    if (!station) return render(res, "预约", "", { code: "rejected", text: "充电站不存在" }, 404);
    const taken = db
      .prepare("SELECT COUNT(*) AS n FROM reservations WHERE station_id = ?")
      .get(stationId).n;
    // FAULT "overbooking"：跳过桩口上限检查。
    if (FAULT !== "overbooking" && taken >= station.ports) {
      const pos = db
        .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM queue WHERE station_id = ?")
        .get(stationId).p;
      db.prepare("INSERT INTO queue (station_id, account, position) VALUES (?, ?, ?)").run(
        stationId,
        user,
        pos,
      );
      // "waitlisted" 不是拒绝：文案刻意避开 已满/拒绝/full。
      return render(res, "预约", "", {
        code: "waitlisted",
        text: `桩口已满，您已排入队列，位置 ${pos}`,
      });
    }
    db.prepare("INSERT INTO reservations (station_id, account, created_at) VALUES (?, ?, ?)").run(
      stationId,
      user,
      new Date().toISOString(),
    );
    return render(res, "预约", "", { code: "ok", text: "预约成功" });
  }

  if (p === "/release" && method === "GET") {
    const stationId = url.searchParams.get("station") ?? STATION_ID;
    const body = `<form method="POST" action="${abs(req, "/release")}">
<input type="hidden" name="station" value="${stationId}">
<button type="submit">确认结束充电 ${stationId}</button>
</form>`;
    return render(res, "结束充电", body);
  }

  if (p === "/release" && method === "POST") {
    const form = await readBody(req);
    const stationId = form.station ?? STATION_ID;
    const user = currentUser(req);
    if (!user) return render(res, "结束充电", "", { code: "rejected", text: "请先登录" }, 401);
    const row = db
      .prepare("SELECT id FROM reservations WHERE station_id = ? AND account = ?")
      .get(stationId, user);
    if (!row) return render(res, "结束充电", "", { code: "rejected", text: "您尚未预约该充电站" });
    db.prepare("DELETE FROM reservations WHERE id = ?").run(row.id);

    if (FAULT === "cancel-keeps-slot") {
      // FAULT：预约删了，但没人递补。
      return render(res, "结束充电", "", { code: "ok", text: "已结束充电" });
    }
    const head = db
      .prepare("SELECT id, account FROM queue WHERE station_id = ? ORDER BY position ASC LIMIT 1")
      .get(stationId);
    if (head) {
      db.prepare("DELETE FROM queue WHERE id = ?").run(head.id);
      db.prepare("INSERT INTO reservations (station_id, account, created_at) VALUES (?, ?, ?)").run(
        stationId,
        head.account,
        new Date().toISOString(),
      );
      return render(res, "结束充电", "", {
        code: "ok",
        text: `已结束充电；队列中的 ${head.account} 已递补`,
      });
    }
    return render(res, "结束充电", "", { code: "ok", text: "已结束充电" });
  }

  return render(res, "404", "", { code: "rejected", text: "未找到页面" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`charging-app listening on http://127.0.0.1:${PORT} (fault=${FAULT || "none"})`);
});
