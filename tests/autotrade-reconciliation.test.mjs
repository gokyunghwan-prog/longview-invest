import test from "node:test";
import assert from "node:assert/strict";

import { reconcileOrderIntents } from "../autotrade/reconciliation.mjs";

function inFlight(overrides = {}) {
  return {
    cycleKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-07-21T00:20:00.000Z",
    orders: [
      {
        checkpointId: "checkpoint-1",
        ticker: "005930",
        side: "buy",
        quantity: 2,
        limitPrice: 70_000,
        status: "submitted",
        brokerOrderId: "12345",
        ...overrides
      }
    ]
  };
}

test("주문번호로 체결 주문을 대조해 terminal 상태로 만든다", () => {
  const result = reconcileOrderIntents({
    inFlight: inFlight(),
    brokerOrders: [
      {
        brokerOrderId: "12345",
        ticker: "005930",
        side: "buy",
        quantity: 2,
        filledQuantity: 2,
        remainingQuantity: 0,
        canceledQuantity: 0,
        limitPrice: 70_000,
        status: "filled"
      }
    ],
    now: new Date("2026-07-21T01:00:00.000Z")
  });
  assert.equal(result.allTerminal, true);
  assert.equal(result.updates[0].status, "filled");
  assert.equal(result.updates[0].filledQuantity, 2);
});

test("부분체결 미결 주문은 취소 대상으로 남긴다", () => {
  const result = reconcileOrderIntents({
    inFlight: inFlight(),
    brokerOrders: [
      {
        brokerOrderId: "12345",
        ticker: "005930",
        side: "buy",
        quantity: 2,
        filledQuantity: 1,
        remainingQuantity: 1,
        canceledQuantity: 0,
        limitPrice: 70_000,
        status: "partial"
      }
    ],
    now: new Date("2026-07-21T01:00:00.000Z")
  });
  assert.equal(result.allTerminal, false);
  assert.equal(result.cancelCandidates.length, 1);
});

test("주문번호가 없어도 전용계좌의 정확히 일치하는 주문 한 건만 복구한다", () => {
  const result = reconcileOrderIntents({
    inFlight: inFlight({ brokerOrderId: null, status: "intent_persisted" }),
    brokerOrders: [
      {
        brokerOrderId: "recovered",
        branchNumber: "00123",
        ticker: "005930",
        side: "buy",
        quantity: 2,
        filledQuantity: 0,
        remainingQuantity: 2,
        canceledQuantity: 0,
        limitPrice: 70_000,
        orderDate: "20260721",
        orderTime: "092100",
        status: "open"
      }
    ],
    now: new Date("2026-07-21T01:00:00.000Z")
  });
  assert.equal(result.ambiguous, false);
  assert.equal(result.updates[0].brokerOrderId, "recovered");
});

test("같은 조건 주문이 둘이면 임의 선택하지 않고 unknown으로 차단한다", () => {
  const order = {
    ticker: "005930",
    side: "buy",
    quantity: 2,
    filledQuantity: 0,
    remainingQuantity: 2,
    limitPrice: 70_000,
    orderDate: "20260721",
    orderTime: "092100",
    status: "open"
  };
  const result = reconcileOrderIntents({
    inFlight: inFlight({ brokerOrderId: null, status: "intent_persisted" }),
    brokerOrders: [
      { ...order, brokerOrderId: "one" },
      { ...order, brokerOrderId: "two" }
    ],
    now: new Date("2026-07-21T01:00:00.000Z")
  });
  assert.equal(result.ambiguous, true);
  assert.equal(result.updates[0].status, "unknown");
});

test("주문내역 없음은 장 마감 뒤 서로 다른 두 번 확인해야만 종료한다", () => {
  const first = reconcileOrderIntents({
    inFlight: inFlight({ brokerOrderId: null, status: "intent_persisted" }),
    brokerOrders: [],
    now: new Date("2026-07-21T07:00:00.000Z")
  });
  assert.equal(first.allTerminal, false);
  assert.equal(first.updates[0].missingChecks, 1);

  const second = reconcileOrderIntents({
    inFlight: { ...inFlight(), orders: first.updates },
    brokerOrders: [],
    now: new Date("2026-07-22T00:20:00.000Z")
  });
  assert.equal(second.allTerminal, true);
  assert.equal(second.updates[0].status, "not_found");
});
