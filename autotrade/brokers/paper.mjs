function finite(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class PaperBroker {
  constructor(stateStore, { feeRate = 0 } = {}) {
    this.stateStore = stateStore;
    this.feeRate = feeRate;
    this.name = "paper";
  }

  async getAccount(prices = new Map()) {
    const state = this.stateStore.snapshot().paper;
    const positions = Object.values(state.positions).map((position) => {
      const quoted = prices.get(position.id);
      const price = finite(
        typeof quoted === "object" ? quoted?.price : quoted,
        position.lastPrice
      );
      // schemaVersion 1 장부에 남은 fxRateKrw: 1은 읽되 국내 평가에는 사용하지 않는다.
      const { fxRateKrw: _legacyFxRateKrw, ...domesticPosition } = position;
      return {
        ...domesticPosition,
        country: "KR",
        currency: "KRW",
        price,
        marketValueKrw: position.quantity * price,
        unrealizedProfitKrw:
          position.quantity * (price - position.averagePrice)
      };
    });
    const positionsValueKrw = positions.reduce(
      (sum, position) => sum + position.marketValueKrw,
      0
    );
    return {
      broker: this.name,
      currency: "KRW",
      cashKrw: state.cashKrw,
      positionsValueKrw,
      totalEquityKrw: state.cashKrw + positionsValueKrw,
      positions
    };
  }

  async placeOrders(orders, { beforeEach = null } = {}) {
    if (beforeEach !== null && typeof beforeEach !== "function") {
      throw new TypeError("모의 주문 직전 안전 확인 함수가 올바르지 않습니다.");
    }
    if (beforeEach) {
      try {
        for (let index = 0; index < orders.length; index += 1) {
          await beforeEach(orders[index], index);
        }
      } catch (error) {
        return orders.map((order) => ({
          ...order,
          status: "blocked",
          reason: String(error?.message || "모의 주문 직전 안전 확인 실패"),
          errorCode: String(error?.code || "PAPER_PRE_ORDER_CHECK_FAILED"),
          notSent: true
        }));
      }
    }
    const results = [];
    await this.stateStore.update(
      (state) => {
        for (const order of orders) {
          const { fxRateKrw: _legacyFxRateKrw, ...sourceOrder } = order;
          const domesticOrder = { ...sourceOrder, country: "KR", currency: "KRW" };
          const quantity = Math.floor(finite(domesticOrder.quantity));
          const price = finite(domesticOrder.limitPrice);
          if (String(order.country || "KR").toUpperCase() !== "KR") {
            results.push({
              ...domesticOrder,
              status: "rejected",
              reason: "국내주식 모의주문만 허용됩니다."
            });
            continue;
          }
          if (quantity <= 0 || price <= 0) {
            results.push({ ...domesticOrder, status: "rejected", reason: "수량 또는 가격 오류" });
            continue;
          }
          const gross = quantity * price;
          const fee = Math.ceil(gross * this.feeRate);
          const existing = state.paper.positions[domesticOrder.id] || null;

          if (domesticOrder.side === "buy") {
            const cost = gross + fee;
            if (cost > state.paper.cashKrw) {
              results.push({ ...domesticOrder, status: "rejected", reason: "모의 현금 부족" });
              continue;
            }
            const previousQuantity = existing?.quantity || 0;
            const nextQuantity = previousQuantity + quantity;
            const averagePrice =
              ((existing?.averagePrice || 0) * previousQuantity + gross) / nextQuantity;
            state.paper.cashKrw -= cost;
            state.paper.positions[domesticOrder.id] = {
              id: domesticOrder.id,
              ticker: domesticOrder.ticker,
              name: domesticOrder.name,
              country: "KR",
              exchange: domesticOrder.exchange,
              sector: domesticOrder.sector,
              currency: "KRW",
              quantity: nextQuantity,
              averagePrice,
              lastPrice: price,
              updatedAt: new Date().toISOString()
            };
          } else if (domesticOrder.side === "sell") {
            if (!existing || existing.quantity < quantity) {
              results.push({ ...domesticOrder, status: "rejected", reason: "모의 보유수량 부족" });
              continue;
            }
            state.paper.cashKrw += Math.max(0, gross - fee);
            const remaining = existing.quantity - quantity;
            if (remaining === 0) delete state.paper.positions[domesticOrder.id];
            else {
              const { fxRateKrw: _legacyExistingFxRateKrw, ...domesticExisting } = existing;
              state.paper.positions[domesticOrder.id] = {
                ...domesticExisting,
                country: "KR",
                currency: "KRW",
                quantity: remaining,
                lastPrice: price,
                updatedAt: new Date().toISOString()
              };
            }
          } else {
            results.push({ ...domesticOrder, status: "rejected", reason: "주문 방향 오류" });
            continue;
          }

          const filled = {
            ...domesticOrder,
            status: "filled",
            filledQuantity: quantity,
            filledPrice: price,
            feeKrw: fee,
            filledAt: new Date().toISOString()
          };
          state.paper.orders.push(filled);
          state.paper.orders = state.paper.orders.slice(-1_000);
          results.push(filled);
        }
      },
      { type: "paper_orders", count: orders.length }
    );
    return results;
  }
}
