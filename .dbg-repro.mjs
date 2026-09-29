#!/usr/bin/env node
/** Minimal repro: drive booking-app directly over HTTP with RC_FAULT set,
 * mirroring the scenario's exact step flow. Prints every banner + final DB. */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appPath = resolve(process.argv[2] ?? "fixtures/booking-app/server.js");
const fault = process.argv[3] ?? "waitlist-order-wrong";
const port = 6288;
const dbPath = join(mkdtempSync(join(tmpdir(), "rcdbg-")), "app.db");

const child = spawn(process.execPath, [appPath], {
  env: {
    ...process.env,
    RC_PORT: String(port),
    RC_DB: dbPath,
    RC_SEED: JSON.stringify([]),
    ...(fault ? { RC_FAULT: fault } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => {
  const line = String(d).trim();
  if (line.includes("listening")) console.log("[app]", line);
});

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${base}/healthz`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const jar = {};
async function call(who, method, path, body) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (jar[who]) headers.Cookie = jar[who];
  const res = await fetch(base + path, { method, headers, body });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) jar[who] = setCookie.split(";")[0];
  const text = await res.text();
  const banner = text.match(/<div id="result"[^>]*>([^<]*)</)?.[1] ?? "(no banner)";
  console.log(`[${who}] ${method} ${path} -> ${res.status} "${banner}"`);
  return text;
}

await call("h", "POST", "/register", "username=holder_rc&password=pw-holder");
await call("h", "POST", "/login", "username=holder_rc&password=pw-holder");
await call("h", "GET", "/book?course=course-1");
await call("h", "POST", "/book", "course=course-1");
await call("h2", "POST", "/register", "username=holder2_rc&password=pw-holder2");
await call("h2", "POST", "/login", "username=holder2_rc&password=pw-holder2");
await call("h2", "GET", "/book?course=course-1");
await call("h2", "POST", "/book", "course=course-1");
await call("b", "POST", "/register", "username=bob_rc&password=pw-bob");
await call("b", "POST", "/login", "username=bob_rc&password=pw-bob");
await call("b", "GET", "/book?course=course-1");
await call("b", "POST", "/book", "course=course-1");
await call("c", "POST", "/register", "username=carol_rc&password=pw-carol");
await call("c", "POST", "/login", "username=carol_rc&password=pw-carol");
await call("c", "GET", "/book?course=course-1");
await call("c", "POST", "/book", "course=course-1");

const db = new DatabaseSync(dbPath);
console.log("before cancel  bookings:", JSON.stringify(db.prepare("SELECT account FROM bookings ORDER BY id").all()));
console.log("before cancel  waitlist:", JSON.stringify(db.prepare("SELECT account, position FROM waitlist ORDER BY position").all()));
await call("h", "GET", "/cancel?course=course-1");
await call("h", "POST", "/cancel", "course=course-1");
console.log("after  cancel  bookings:", JSON.stringify(db.prepare("SELECT account FROM bookings ORDER BY id").all()));
console.log("after  cancel  waitlist:", JSON.stringify(db.prepare("SELECT account, position FROM waitlist ORDER BY position").all()));
child.kill("SIGTERM");
rmSync(join(dbPath, ".."), { recursive: true, force: true });
