import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickScenario } from "../src/heuristic.js";
import { planWithModel } from "../src/model.js";
import { planScenario } from "../src/index.js";
import type { ModelClient, PlanRequest } from "../src/types.js";
import type { Scenario } from "@rc/protocol";

function mkScenario(id: string): Scenario {
  return {
    protocol: { scenario: "1.1" },
    id,
    name: id,
    description: `scenario ${id}`,
    app: "booking",
    roles: [],
    steps: [],
    observers: [],
    assertions: [],
    rules: [],
    seed: 42,
  };
}

const SAVED: readonly Scenario[] = [
  mkScenario("booking-normal"),
  mkScenario("booking-contend"),
  mkScenario("booking-cancel-waitlist"),
];

function req(request: string, saved: readonly Scenario[] = SAVED, model?: ModelClient): PlanRequest {
  const r: PlanRequest = { request, savedScenarios: [...saved] };
  if (model !== undefined) r.model = model;
  return r;
}

const BUDGET = { timeoutMs: 200, maxTokens: 64 };

describe("pickScenario keyword heuristic", () => {
  it("normal category (zh + en) picks the saved 'normal' scenario", () => {
    for (const text of ["帮我报名普通场次", "please book a normal slot", "normal booking"]) {
      const d = pickScenario(req(text));
      assert.equal(d.scenario?.id, "booking-normal", text);
      assert.equal(d.fallback, "heuristic");
      assert.equal(d.needsModel, false);
    }
  });

  it("contend category (zh + en) picks the saved 'contend' scenario", () => {
    for (const text of ["两人争抢同一个名额", "3人抢票", "everyone race for the last seat", "contend for it"]) {
      const d = pickScenario(req(text));
      assert.equal(d.scenario?.id, "booking-contend", text);
    }
  });

  it("cancel-waitlist category (zh + en) picks the saved 'cancel-waitlist' scenario", () => {
    for (const text of ["取消订单进入候补", "cancel my order", "put me on the waitlist", "候补排队"]) {
      const d = pickScenario(req(text));
      assert.equal(d.scenario?.id, "booking-cancel-waitlist", text);
    }
  });

  it("extracts counts like 3人 / 3 people / n=3 into params.count", () => {
    assert.equal(pickScenario(req("3人争抢名额")).params.count, 3);
    assert.equal(pickScenario(req("3 people race for seats")).params.count, 3);
    assert.equal(pickScenario(req("n=3 normal booking")).params.count, 3);
    assert.deepEqual(pickScenario(req("帮我报名")).params, {});
  });

  it("英文关键词按整词匹配：噪声词不会把请求判成另一个类别", () => {
    // race/book/last 曾经是裸子串：trace、facebook 都会被当成"有线索"，于是一次
    // 无关请求会**高置信度地**跑错场景（needsModel:false + fallback:heuristic）。
    for (const text of ["please trace the login flow", "check facebook registration page"]) {
      const d = pickScenario(req(text));
      assert.equal(d.needsModel, true, `${text} must not be treated as a category clue`);
      assert.equal(d.scenario, undefined, text);
    }
    // "last-minute cancellation" 的真实意图是取消，不是争抢：旧代码因为 "last" 出现在
    // 更前面而判成 contend。
    assert.equal(
      pickScenario(req("last-minute cancellation of my booking")).scenario?.id,
      "booking-cancel-waitlist",
    );
    // 词形变化仍然命中（词首匹配，不要求词尾）
    assert.equal(pickScenario(req("race for the last seat")).scenario?.id, "booking-contend");
    assert.equal(pickScenario(req("please book a slot")).scenario?.id, "booking-normal");
    assert.equal(pickScenario(req("bookings overview")).scenario?.id, "booking-normal");
  });

  it("count 抽取：显式 n= 优先于自然语句，超出上下界则不猜", () => {
    // "10人会议室…n=3" 想要的是 3：显式赋值比散文里的数字可靠。
    assert.equal(pickScenario(req("10人会议室，抢最后名额 n=3")).params.count, 3);
    // 容量/无关数字（超出 1..1000）不当作人数：宁可不给参数。
    assert.deepEqual(pickScenario(req("9999人抢票")).params, {});
    assert.deepEqual(pickScenario(req("0人抢票")).params, {});
  });

  it("no category clue -> needsModel with NO scenario (no default guessed, 方案 §3.3 规则 9)", () => {
    const d = pickScenario(req("随便看看这个系统"));
    assert.equal(d.needsModel, true);
    assert.equal(d.fallback, "needs-model");
    assert.equal(d.scenario, undefined);
    assert.match(d.reason, /no category clue/);
  });

  it("clue matches but no saved scenario contains the token -> needsModel with NO scenario", () => {
    const d = pickScenario(req("3人抢票", [mkScenario("booking-normal")]));
    assert.equal(d.needsModel, true);
    assert.equal(d.fallback, "needs-model");
    assert.equal(d.scenario, undefined);
    assert.match(d.reason, /no saved scenario id contains "contend"/);
  });
});

describe("planWithModel fallbacks", () => {
  it("model undefined with a clue -> keyword-closest saved scenario with model-error reason", async () => {
    const d = await planWithModel(req("3人抢票"), BUDGET);
    assert.equal(d.fallback, "model-error");
    assert.equal(d.needsModel, false);
    assert.equal(d.scenario?.id, "booking-contend");
    assert.match(d.reason, /no model client configured/);
  });

  it("model undefined and no clue -> needsModel with NO scenario, never a guessed default", async () => {
    const d = await planWithModel(req("随便看看"), BUDGET);
    assert.equal(d.needsModel, true);
    assert.equal(d.scenario, undefined);
    assert.match(d.reason, /refusing to guess a default scenario/);
  });

  it("model that throws -> model-error with distinct reason", async () => {
    const boom: ModelClient = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const d = await planWithModel(req("3人抢票", SAVED, boom), BUDGET);
    assert.equal(d.fallback, "model-error");
    assert.equal(d.needsModel, false);
    assert.equal(d.scenario?.id, "booking-contend");
    assert.match(d.reason, /model call failed: boom/);
  });

  it("model that hangs -> timeout fallback with distinct reason", async () => {
    const hangs: ModelClient = { complete: () => new Promise<string>(() => {}) };
    const d = await planWithModel(req("3人抢票", SAVED, hangs), { timeoutMs: 30, maxTokens: 16 });
    assert.equal(d.fallback, "model-error");
    assert.equal(d.needsModel, false);
    assert.equal(d.scenario?.id, "booking-contend");
    assert.match(d.reason, /timed out after 30ms/);
  });

  it("model returning garbage -> parse fallback with distinct reason", async () => {
    const garbage: ModelClient = { complete: async () => "this is not json at all" };
    const d = await planWithModel(req("3人抢票", SAVED, garbage), BUDGET);
    assert.equal(d.fallback, "model-error");
    assert.match(d.reason, /not valid JSON/);
  });

  it("model returning non-object JSON -> distinct reason", async () => {
    const array: ModelClient = { complete: async () => "[1,2,3]" };
    const d = await planWithModel(req("3人抢票", SAVED, array), BUDGET);
    assert.equal(d.fallback, "model-error");
    assert.match(d.reason, /not an object/);
  });

  it("model returning unknown scenario id -> distinct reason", async () => {
    const unknown: ModelClient = {
      complete: async () => JSON.stringify({ scenarioId: "no-such-scenario", params: {} }),
    };
    const d = await planWithModel(req("3人抢票", SAVED, unknown), BUDGET);
    assert.equal(d.fallback, "model-error");
    assert.equal(d.needsModel, false);
    assert.equal(d.scenario?.id, "booking-contend");
    assert.match(d.reason, /unknown scenario id "no-such-scenario"/);
  });

  it("the four failure reasons are all distinct", async () => {
    const boom: ModelClient = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const hangs: ModelClient = { complete: () => new Promise<string>(() => {}) };
    const garbage: ModelClient = { complete: async () => "not json" };
    const unknown: ModelClient = {
      complete: async () => JSON.stringify({ scenarioId: "nope", params: {} }),
    };
    const reasons = [
      (await planWithModel(req("抢票", SAVED, boom), { timeoutMs: 30, maxTokens: 16 })).reason,
      (await planWithModel(req("抢票", SAVED, hangs), { timeoutMs: 30, maxTokens: 16 })).reason,
      (await planWithModel(req("抢票", SAVED, garbage), { timeoutMs: 30, maxTokens: 16 })).reason,
      (await planWithModel(req("抢票", SAVED, unknown), { timeoutMs: 30, maxTokens: 16 })).reason,
    ];
    assert.equal(new Set(reasons).size, 4);
  });

  it("successful bounded model reply selects the saved scenario and params", async () => {
    const ok: ModelClient = {
      complete: async () => JSON.stringify({ scenarioId: "booking-contend", params: { count: 3, bogus: null } }),
    };
    const d = await planWithModel(req("帮我安排一下", SAVED, ok), BUDGET);
    assert.equal(d.needsModel, false);
    assert.equal(d.scenario?.id, "booking-contend");
    assert.deepEqual(d.params, { count: 3 });
    // 来源必须如实：这是模型选的，不是关键词启发式选的（曾写成 "heuristic"，
    // 与同一返回里的 reason 自相矛盾，工作台会把错误来源显示给用户）。
    assert.equal(d.fallback, "saved-scenario");
    assert.match(d.reason, /bounded model selected/);
  });
});

describe("planScenario", () => {
  it("keyword hit resolves without touching the model", async () => {
    const d = await planScenario(req("3人抢票"));
    assert.equal(d.fallback, "heuristic");
    assert.equal(d.scenario?.id, "booking-contend");
    assert.equal(d.needsModel, false);
  });

  it("no clue and no model -> needsModel with NO scenario, never throws, never guesses (规则 9)", async () => {
    const d = await planScenario(req("随便看看"));
    assert.equal(d.needsModel, true);
    assert.equal(d.scenario, undefined);
    assert.match(d.reason, /refusing to guess a default scenario/);
  });

  it("needs-model with a working model uses the bounded model path", async () => {
    const ok: ModelClient = {
      complete: async () => JSON.stringify({ scenarioId: "booking-cancel-waitlist", params: {} }),
    };
    const d = await planScenario(req("帮我安排一下", SAVED, ok));
    assert.equal(d.scenario?.id, "booking-cancel-waitlist");
    assert.match(d.reason, /bounded model selected/);
  });

  it("empty savedScenarios and no clue -> needsModel decision (no throw, no scenario)", async () => {
    const d = await planScenario(req("随便看看", []));
    assert.equal(d.needsModel, true);
    assert.equal(d.scenario, undefined);
  });
});
