import { UNATTENDED_LIVE_ACKNOWLEDGEMENT } from "./config.mjs";

function kstParts(now) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function isWeekday(value) {
  return !["Sat", "Sun"].includes(value);
}

export class TradingScheduler {
  constructor(
    engine,
    config,
    {
      now = () => new Date(),
      intervalMs = 30_000,
      onResult = () => {},
      onError = () => {}
    } = {}
  ) {
    this.engine = engine;
    this.config = config;
    this.now = now;
    this.intervalMs = intervalMs;
    this.onResult = onResult;
    this.onError = onError;
    this.timer = null;
    this.active = null;
    this.lastAttemptDate = null;
  }

  due(now = this.now()) {
    if (!this.config.scheduler.enabled || this.lastAttemptDate) {
      const parts = kstParts(now);
      if (!this.config.scheduler.enabled || this.lastAttemptDate === parts.date) return false;
    }
    const parts = kstParts(now);
    if (!isWeekday(parts.weekday)) return false;
    const currentMinute = parts.hour * 60 + parts.minute;
    const scheduledMinute =
      this.config.scheduler.hourKst * 60 + this.config.scheduler.minuteKst;
    const localPaper =
      this.config.mode === "paper" && this.config.broker === "paper";
    // Local simulation has no market-order side effect, so an evening PC start
    // may catch up until midnight after the daily dataset has refreshed. KIS
    // (including virtual KIS) and live orders stay inside the KRX safety window.
    const cutoffMinute = localPaper ? 24 * 60 : 15 * 60;
    return currentMinute >= scheduledMinute && currentMinute < cutoffMinute;
  }

  async check() {
    if (this.active || !this.due()) return null;
    const parts = kstParts(this.now());
    this.lastAttemptDate = parts.date;
    const unattendedLiveConfirmation =
      this.config.mode === "live" &&
      this.config.scheduler.unattendedLiveEnabled === true &&
      this.config.scheduler.unattendedAcknowledgement ===
        UNATTENDED_LIVE_ACKNOWLEDGEMENT;
    this.active = this.engine
      .execute({
        trigger: "scheduler",
        liveConfirmation: unattendedLiveConfirmation
      })
      .then((result) => {
        this.onResult(result);
        return result;
      })
      .catch((error) => {
        this.onError(error);
        return null;
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }

  start() {
    if (this.timer || !this.config.scheduler.enabled) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
