/** 脱敏规则单测（方案 §8 证据包脱敏检查）。规则是显式表，所以这里逐条钉住行为，
 * 并保证"已知敏感值优先"与"反扫能发现残留"两件关键性质。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTION_RULES, findLeaks, sanitizeJsonValue, sanitizeText } from "../src/sanitize.js";

describe("sanitizeText", () => {
  it("replaces known secrets literally, longest first", () => {
    const res = sanitizeText("run at D:/aimanage/Reality Check/runs/x and D:/aimanage", [
      "D:/aimanage",
      "D:/aimanage/Reality Check/runs/x",
    ]);
    assert.equal(res.text, "run at <redacted> and <redacted>");
    assert.deepEqual(res.redactions, [{ rule: "known-secret", count: 2 }]);
  });

  it("redacts tool-created account names, absolute paths, ports, emails and keys", () => {
    const input = [
      "登录成功（alice_rc）",
      "dbPath=C:\\Users\\Lenovo\\AppData\\Local\\Temp\\rc-1\\data\\app.db",
      "baseUrl=http://127.0.0.1:54432/",
      "ops@example.com",
      "token sk-abcdefghijklmnop",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "/home/runner/work/x/evidence/step-1.png",
    ].join(" | ");
    const res = sanitizeText(input);
    assert.doesNotMatch(res.text, /alice_rc/);
    assert.doesNotMatch(res.text, /C:\\Users\\Lenovo/);
    assert.doesNotMatch(res.text, /127\.0\.0\.1:54432/);
    assert.doesNotMatch(res.text, /ops@example\.com/);
    assert.doesNotMatch(res.text, /sk-abcdefghijklmnop/);
    assert.doesNotMatch(res.text, /abcdefghijklmnopqrstuvwxyz012345/);
    assert.doesNotMatch(res.text, /\/home\/runner/);
    const rules = res.redactions.map((r) => r.rule);
    for (const expected of [
      "account-token",
      "windows-path",
      "loopback-port",
      "email",
      "api-key",
      "bearer-token",
      "posix-path",
    ]) {
      assert.ok(rules.includes(expected), `rule ${expected} must fire (got ${rules.join(",")})`);
    }
  });

  it("keeps business facts that are not sensitive", () => {
    const res = sanitizeText("run rc-abc123: failed (exit 1) held capacity-not-exceeded");
    assert.equal(res.text, "run rc-abc123: failed (exit 1) held capacity-not-exceeded");
    assert.deepEqual(res.redactions, []);
  });

  it("is idempotent on already-sanitized text", () => {
    const once = sanitizeText("alice_rc at C:\\tmp\\x").text;
    const twice = sanitizeText(once).text;
    assert.equal(twice, once);
  });

  it("redacts private keys wholesale", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    assert.equal(sanitizeText(pem).text, "<private-key>");
  });

  it("exposes the rule table for auditing", () => {
    assert.ok(REDACTION_RULES.length >= 8);
    for (const rule of REDACTION_RULES) assert.ok(rule.name.length > 0 && rule.pattern instanceof RegExp);
  });
});

describe("sanitizeJsonValue", () => {
  it("walks nested structures and aggregates per-rule counts", () => {
    const { value, redactions } = sanitizeJsonValue({
      runId: "rc-1",
      env: { dbPath: "D:\\runs\\rc-1\\data\\app.db", baseUrl: "http://127.0.0.1:1234" },
      attempts: [{ detail: { banner: "登录成功（bob_rc）" } }],
    });
    const json = JSON.stringify(value);
    assert.doesNotMatch(json, /bob_rc/);
    assert.doesNotMatch(json, /D:\\\\runs/);
    assert.doesNotMatch(json, /127\.0\.0\.1:1234/);
    assert.ok(redactions.some((r) => r.rule === "account-token"));
    assert.ok(redactions.every((r) => r.count > 0));
  });
});

describe("findLeaks", () => {
  it("returns every surviving secret (the export gate)", () => {
    const text = "path D:/runs/rc-1 and account alice_rc";
    const leaks = findLeaks(text, ["D:/runs/rc-1", "alice_rc", "not-present"]);
    assert.deepEqual(leaks, ["D:/runs/rc-1", "alice_rc"]);
  });

  it("ignores trivially short values to avoid false positives", () => {
    assert.deepEqual(findLeaks("abc", ["ab"]), []);
  });

  it("truncates very long hits in the report", () => {
    const long = "x".repeat(200);
    const [leak] = findLeaks(`prefix ${long}`, [long]);
    assert.ok(leak !== undefined && leak.endsWith("…") && leak.length <= 81);
  });
});
