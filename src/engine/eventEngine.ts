import type { GameState } from "../models/index.js";
import { HISTORICAL_EVENTS, type HistoricalEvent } from "../data/historicalEvents.js";

/**
 * EventEngine（設計書 11章）。
 * 年始フェイズで、その年に該当する史実イベント（`historicalEvents.ts`）があれば適用する。
 * イベントは既定で全て有効だが、`events` に空配列や絞り込んだ配列を渡すことで
 * シナリオごとにON/OFFできる（設計書 11章「任意でON/OFFできるシナリオイベント」）。
 */
export interface EventApplicationResult {
  readonly state: GameState;
  /** この年に実際に適用されたイベント（UI・ターンサマリー表示や検証に使う）。 */
  readonly appliedEvents: readonly HistoricalEvent[];
}

export function applyYearStartEvents(
  state: GameState,
  events: readonly HistoricalEvent[] = HISTORICAL_EVENTS,
): EventApplicationResult {
  const applicable = events.filter((event) => event.year === state.year);
  let next = state;
  for (const event of applicable) {
    next = event.apply(next);
  }
  return { state: next, appliedEvents: applicable };
}
