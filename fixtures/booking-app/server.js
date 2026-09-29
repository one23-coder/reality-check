// 课程报名 reference app — plain node:http + node:sqlite, ZERO npm deps, ESM.
// Env contract: RC_PORT, RC_DB, RC_SEED (JSON [{username,password,seedRole}]),
// RC_FAULT (unset | "overbooking" | "cancel-keeps-slot" | "waitlist-order-wrong").
// Server-rendered HTML, native forms with ABSOLUTE action URLs (方案 §3.3 规则 5),
// in-memory cookie sessions, WAL journal (规则 1).
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.RC_PORT ?? 3000);
const DB_PATH = process.env.RC_DB ?? ":memory:";
const FAULT = process.env.RC_FAULT ?? "";
const COURSE_ID = "course-1";
const COURSE_CAPACITY = 2;

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
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  account TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  account TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  seed_role TEXT NOT NULL DEFAULT 'none'
);
`);

db.prepare("INSERT OR IGNORE INTO courses (id, name, capacity) VALUES (?, ?, ?)").run(
  COURSE_ID,
  "高等数学",
  COURSE_CAPACITY,
);

// Seed accounts. 规则 7: only seedRole "holder" occupies an initial slot;
// "none" / "waitlisted" never create a booking.
for (const s of seedAccounts) {
  if (!s || typeof s.username !== "string" || typeof s.password !== "string") continue;
  const seedRole = typeof s.seedRole === "string" ? s.seedRole : "none";
  db.prepare(
    "INSERT OR IGNORE INTO accounts (username, password, seed_role) VALUES (?, ?, ?)",
  ).run(s.username, s.password, seedRole);
  if (seedRole === "holder") {
    const existing = db
      .prepare("SELECT id FROM bookings WHERE course_id = ? AND account = ?")
      .get(COURSE_ID, s.username);
    if (!existing) {
      db.prepare(
        "INSERT INTO bookings (course_id, account, created_at) VALUES (?, ?, ?)",
      ).run(COURSE_ID, s.username, new Date().toISOString());
    }
  } else if (seedRole === "waitlisted") {
    const existing = db
      .prepare("SELECT id FROM waitlist WHERE course_id = ? AND account = ?")
      .get(COURSE_ID, s.username);
    if (!existing) {
      const pos = db
        .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM waitlist WHERE course_id = ?")
        .get(COURSE_ID).p;
      db.prepare("INSERT INTO waitlist (course_id, account, position) VALUES (?, ?, ?)").run(
        COURSE_ID,
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

/** Every page ends with <div id="result" data-result="...">…</div>. */
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
      `SELECT c.id, c.name, c.capacity,
              (SELECT COUNT(*) FROM bookings b WHERE b.course_id = c.id) AS booked
       FROM courses c ORDER BY c.id`,
    )
    .all()
    .map((c) => {
      const left = c.capacity - c.booked;
      return `<li>${c.name} (${c.id}) — 容量 ${c.capacity}，已报 ${c.booked}，剩余 ${left} — <a href="${abs(req, `/book?course=${c.id}`)}">报名</a> | <a href="${abs(req, `/cancel?course=${c.id}`)}">取消报名</a></li>`;
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
    return sendJson(res, 200, { ok: true, app: "booking-app", version: "0.1.0" });
  }

  if (p === "/" && method === "GET") {
    return render(res, "课程报名", homeBody(req));
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
        // RC_SEED-seeded accounts re-register through the UI/adapter: idempotent.
        return render(res, "注册", registerForm(req), {
          code: "ok",
          text: `账号已存在，密码匹配（${username}）`,
        });
      }
      return render(res, "注册", registerForm(req), {
        code: "rejected",
        text: "用户名已被占用",
      }, 409);
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

  if (p === "/book" && method === "GET") {
    const courseId = url.searchParams.get("course") ?? COURSE_ID;
    const course = db.prepare("SELECT id, name FROM courses WHERE id = ?").get(courseId);
    if (!course) {
      return render(res, "报名", "", { code: "rejected", text: "课程不存在" }, 404);
    }
    const body = `<form method="POST" action="${abs(req, "/book")}">
<input type="hidden" name="course" value="${course.id}">
<button type="submit">确认报名 ${course.name}</button>
</form>`;
    return render(res, "报名", body);
  }

  if (p === "/book" && method === "POST") {
    const form = await readBody(req);
    const courseId = form.course ?? COURSE_ID;
    const user = currentUser(req);
    if (!user) {
      return render(res, "报名", "", { code: "rejected", text: "请先登录后再报名" }, 401);
    }
    const course = db.prepare("SELECT id, capacity FROM courses WHERE id = ?").get(courseId);
    if (!course) {
      return render(res, "报名", "", { code: "rejected", text: "课程不存在" }, 404);
    }
    const booked = db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE course_id = ?")
      .get(courseId).n;
    // FAULT "overbooking": the capacity check is skipped entirely.
    if (FAULT !== "overbooking" && booked >= course.capacity) {
      const pos = db
        .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM waitlist WHERE course_id = ?")
        .get(courseId).p;
      db.prepare("INSERT INTO waitlist (course_id, account, position) VALUES (?, ?, ?)").run(
        courseId,
        user,
        pos,
      );
      // "waitlisted" is NOT a rejection: text deliberately avoids 已满/拒绝/full.
      return render(res, "报名", "", {
        code: "waitlisted",
        text: `手慢了，您已加入候补队列，位置 ${pos}`,
      });
    }
    db.prepare("INSERT INTO bookings (course_id, account, created_at) VALUES (?, ?, ?)").run(
      courseId,
      user,
      new Date().toISOString(),
    );
    return render(res, "报名", "", { code: "ok", text: "报名成功" });
  }

  if (p === "/cancel" && method === "GET") {
    const courseId = url.searchParams.get("course") ?? COURSE_ID;
    const body = `<form method="POST" action="${abs(req, "/cancel")}">
<input type="hidden" name="course" value="${courseId}">
<button type="submit">确认取消报名 ${courseId}</button>
</form>`;
    return render(res, "取消报名", body);
  }

  if (p === "/cancel" && method === "POST") {
    const form = await readBody(req);
    const courseId = form.course ?? COURSE_ID;
    const user = currentUser(req);
    if (!user) {
      return render(res, "取消报名", "", { code: "rejected", text: "请先登录" }, 401);
    }
    const booking = db
      .prepare("SELECT id FROM bookings WHERE course_id = ? AND account = ?")
      .get(courseId, user);
    if (!booking) {
      return render(res, "取消报名", "", { code: "rejected", text: "您尚未报名该课程" });
    }
    db.prepare("DELETE FROM bookings WHERE id = ?").run(booking.id);

    if (FAULT === "cancel-keeps-slot") {
      // FAULT: booking deleted, but the slot frees nothing and promotes nobody.
      return render(res, "取消报名", "", { code: "ok", text: "已取消报名" });
    }

    // CORRECT behavior: promote the FIRST waitlist row into a booking.
    // FAULT "waitlist-order-wrong": promotes the LAST row instead.
    const direction = FAULT === "waitlist-order-wrong" ? "DESC" : "ASC";
    const head = db
      .prepare(
        `SELECT id, account FROM waitlist WHERE course_id = ? ORDER BY position ${direction} LIMIT 1`,
      )
      .get(courseId);
    if (head) {
      db.prepare("DELETE FROM waitlist WHERE id = ?").run(head.id);
      db.prepare("INSERT INTO bookings (course_id, account, created_at) VALUES (?, ?, ?)").run(
        courseId,
        head.account,
        new Date().toISOString(),
      );
      return render(res, "取消报名", "", {
        code: "ok",
        text: `已取消报名；候补 ${head.account} 已递补成功`,
      });
    }
    return render(res, "取消报名", "", { code: "ok", text: "已取消报名" });
  }

  return render(res, "404", "", { code: "rejected", text: "未找到页面" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`booking-app listening on http://127.0.0.1:${PORT} (fault=${FAULT || "none"})`);
});
