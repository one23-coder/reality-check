// 考试座位预约 app — an independent second fixture (different domain, schema and
// endpoints from booking-app; NOT a reskin). Plain node:http + node:sqlite,
// ZERO npm deps, ESM.
// Env contract: RC_PORT, RC_DB, RC_SEED, RC_FAULT
//   (unset | "overbooking" | "cancel-keeps-seat" | "waitlist-order-wrong").
// Native forms with ABSOLUTE action URLs, in-memory cookie sessions, WAL.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.RC_PORT ?? 3000);
const DB_PATH = process.env.RC_DB ?? ":memory:";
const FAULT = process.env.RC_FAULT ?? "";
const EXAM_ID = "exam-1";
const EXAM_CAPACITY = 2;

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
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id TEXT NOT NULL,
  account TEXT NOT NULL,
  seat INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id TEXT NOT NULL,
  account TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  seed_role TEXT NOT NULL DEFAULT 'none'
);
`);

db.prepare("INSERT OR IGNORE INTO exams (id, name, capacity) VALUES (?, ?, ?)").run(
  EXAM_ID,
  "期末考试",
  EXAM_CAPACITY,
);

// Seed. 规则 7: only "holder" occupies a seat; "none"/"waitlisted" do not.
for (const s of seedAccounts) {
  if (!s || typeof s.username !== "string" || typeof s.password !== "string") continue;
  const seedRole = typeof s.seedRole === "string" ? s.seedRole : "none";
  db.prepare(
    "INSERT OR IGNORE INTO accounts (username, password, seed_role) VALUES (?, ?, ?)",
  ).run(s.username, s.password, seedRole);
  if (seedRole === "holder") {
    const existing = db
      .prepare("SELECT id FROM reservations WHERE exam_id = ? AND account = ?")
      .get(EXAM_ID, s.username);
    if (!existing) {
      const seat = db
        .prepare("SELECT COALESCE(MAX(seat), 0) + 1 AS seat FROM reservations WHERE exam_id = ?")
        .get(EXAM_ID).seat;
      db.prepare(
        "INSERT INTO reservations (exam_id, account, seat, created_at) VALUES (?, ?, ?, ?)",
      ).run(EXAM_ID, s.username, seat, new Date().toISOString());
    }
  } else if (seedRole === "waitlisted") {
    const existing = db
      .prepare("SELECT id FROM waitlist WHERE exam_id = ? AND account = ?")
      .get(EXAM_ID, s.username);
    if (!existing) {
      const pos = db
        .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM waitlist WHERE exam_id = ?")
        .get(EXAM_ID).p;
      db.prepare("INSERT INTO waitlist (exam_id, account, position) VALUES (?, ?, ?)").run(
        EXAM_ID,
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
    if (k === "rc_session") {
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
      `SELECT e.id, e.name, e.capacity,
              (SELECT COUNT(*) FROM reservations r WHERE r.exam_id = e.id) AS taken
       FROM exams e ORDER BY e.id`,
    )
    .all()
    .map((e) => {
      const left = e.capacity - e.taken;
      return `<li>${e.name} (${e.id}) — 座位数 ${e.capacity}，已预约 ${e.taken}，剩余 ${left} — <a href="${abs(req, `/reserve?exam=${e.id}`)}">预约座位</a> | <a href="${abs(req, `/cancel?exam=${e.id}`)}">取消预约</a></li>`;
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
    return sendJson(res, 200, { ok: true, app: "exam-seat-app", version: "0.1.0" });
  }

  if (p === "/" && method === "GET") {
    return render(res, "考试座位预约", homeBody(req));
  }

  if (p === "/register") {
    if (method === "GET") {
      return render(res, "注册", registerForm(req));
    }
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
    if (method === "GET") {
      return render(res, "登录", loginForm(req));
    }
    const form = await readBody(req);
    const row = db
      .prepare("SELECT password FROM accounts WHERE username = ?")
      .get(form.username ?? "");
    if (!row || row.password !== form.password) {
      return render(res, "登录", loginForm(req), { code: "rejected", text: "用户名或密码错误" });
    }
    const token = randomUUID();
    sessions.set(token, form.username);
    res.setHeader("set-cookie", `rc_session=${token}; Path=/`);
    return render(res, "登录", loginForm(req), { code: "ok", text: `登录成功（${form.username}）` });
  }

  if (p === "/reserve" && method === "GET") {
    const examId = url.searchParams.get("exam") ?? EXAM_ID;
    const exam = db.prepare("SELECT id, name FROM exams WHERE id = ?").get(examId);
    if (!exam) {
      return render(res, "座位预约", "", { code: "rejected", text: "考试不存在" }, 404);
    }
    const body = `<form method="POST" action="${abs(req, "/reserve")}">
<input type="hidden" name="exam" value="${exam.id}">
<button type="submit">确认预约 ${exam.name} 座位</button>
</form>`;
    return render(res, "座位预约", body);
  }

  if (p === "/reserve" && method === "POST") {
    const form = await readBody(req);
    const examId = form.exam ?? EXAM_ID;
    const user = currentUser(req);
    if (!user) {
      return render(res, "座位预约", "", { code: "rejected", text: "请先登录后再预约" }, 401);
    }
    const exam = db.prepare("SELECT id, capacity FROM exams WHERE id = ?").get(examId);
    if (!exam) {
      return render(res, "座位预约", "", { code: "rejected", text: "考试不存在" }, 404);
    }
    const taken = db
      .prepare("SELECT COUNT(*) AS n FROM reservations WHERE exam_id = ?")
      .get(examId).n;
    // FAULT "overbooking": the seat-availability check is skipped entirely.
    if (FAULT !== "overbooking" && taken >= exam.capacity) {
      const pos = db
        .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM waitlist WHERE exam_id = ?")
        .get(examId).p;
      db.prepare("INSERT INTO waitlist (exam_id, account, position) VALUES (?, ?, ?)").run(
        examId,
        user,
        pos,
      );
      return render(res, "座位预约", "", {
        code: "waitlisted",
        text: `座位已被占先，您已加入候补队列，位置 ${pos}`,
      });
    }
    const seat = db
      .prepare("SELECT COALESCE(MAX(seat), 0) + 1 AS seat FROM reservations WHERE exam_id = ?")
      .get(examId).seat;
    db.prepare(
      "INSERT INTO reservations (exam_id, account, seat, created_at) VALUES (?, ?, ?, ?)",
    ).run(examId, user, seat, new Date().toISOString());
    return render(res, "座位预约", "", { code: "ok", text: `预约成功，座位号 ${seat}` });
  }

  if (p === "/cancel" && method === "GET") {
    const examId = url.searchParams.get("exam") ?? EXAM_ID;
    const body = `<form method="POST" action="${abs(req, "/cancel")}">
<input type="hidden" name="exam" value="${examId}">
<button type="submit">确认取消预约 ${examId}</button>
</form>`;
    return render(res, "取消预约", body);
  }

  if (p === "/cancel" && method === "POST") {
    const form = await readBody(req);
    const examId = form.exam ?? EXAM_ID;
    const user = currentUser(req);
    if (!user) {
      return render(res, "取消预约", "", { code: "rejected", text: "请先登录" }, 401);
    }
    const reservation = db
      .prepare("SELECT id FROM reservations WHERE exam_id = ? AND account = ?")
      .get(examId, user);
    if (!reservation) {
      return render(res, "取消预约", "", { code: "rejected", text: "您尚未预约该考试" });
    }
    db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);

    if (FAULT === "cancel-keeps-seat") {
      // FAULT: reservation deleted, but the seat frees nothing and promotes nobody.
      return render(res, "取消预约", "", { code: "ok", text: "已取消预约" });
    }

    // CORRECT: promote the FIRST waitlist row; FAULT "waitlist-order-wrong": last.
    const direction = FAULT === "waitlist-order-wrong" ? "DESC" : "ASC";
    const head = db
      .prepare(
        `SELECT id, account FROM waitlist WHERE exam_id = ? ORDER BY position ${direction} LIMIT 1`,
      )
      .get(examId);
    if (head) {
      db.prepare("DELETE FROM waitlist WHERE id = ?").run(head.id);
      const seat = db
        .prepare("SELECT COALESCE(MAX(seat), 0) + 1 AS seat FROM reservations WHERE exam_id = ?")
        .get(examId).seat;
      db.prepare(
        "INSERT INTO reservations (exam_id, account, seat, created_at) VALUES (?, ?, ?, ?)",
      ).run(examId, head.account, seat, new Date().toISOString());
      return render(res, "取消预约", "", {
        code: "ok",
        text: `已取消预约；候补 ${head.account} 已递补成功，座位号 ${seat}`,
      });
    }
    return render(res, "取消预约", "", { code: "ok", text: "已取消预约" });
  }

  return render(res, "404", "", { code: "rejected", text: "未找到页面" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`exam-seat-app listening on http://127.0.0.1:${PORT} (fault=${FAULT || "none"})`);
});
