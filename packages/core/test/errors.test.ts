import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configError, internalError, isRunError, RunError } from "../src/errors.js";

describe("RunError taxonomy", () => {
  it("config errors map to exit 64", () => {
    const e = configError("bad scenario");
    assert.equal(e.kind, "config");
    assert.equal(e.exitCode, 64);
    assert.ok(e instanceof RunError);
    assert.match(e.message, /\[config\] bad scenario/);
  });

  it("internal errors map to exit 70", () => {
    const plain = internalError("kernel fault");
    assert.equal(plain.kind, "internal");
    assert.equal(plain.exitCode, 70);
    const caused = internalError("kernel fault", new Error("boom"));
    assert.equal(caused.exitCode, 70);
    assert.match(caused.message, /boom/);
    const nonErrorCause = internalError("kernel fault", "string cause");
    assert.equal(nonErrorCause.exitCode, 70);
  });

  it("isRunError discriminates", () => {
    assert.equal(isRunError(configError("x")), true);
    assert.equal(isRunError(new Error("plain")), false);
    assert.equal(isRunError("nope"), false);
    assert.equal(isRunError(null), false);
  });
});
