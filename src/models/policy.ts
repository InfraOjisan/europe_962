/**
 * キャラクターの行動方針（Policy）。設計書 9章「AI意思決定システム」。
 *
 * 史実で行動原理が明確な人物（初期データの主要君主など）は個別に指定し、
 * それ以外（記録の乏しい分家当主・戦闘隊長・宰相など）は生成時にこの4種から
 * 一様乱数で割り当てる（`assignRandomPolicy`、`src/engine/aiPolicy.ts`）。
 *
 * - self_preservation: 自己の生存。家名・自分の身の安全を最優先する。
 * - expansionism:       領主の勢力拡大。版図・軍事力の拡大を最優先する。
 * - self_interest:      自己の利益拡大。財産・地位・私腹を最優先する。
 * - justice:             社会的正義の執行。民の安寧・秩序・信義を重視する。
 */
export type Policy = "self_preservation" | "expansionism" | "self_interest" | "justice";

export const ALL_POLICIES: readonly Policy[] = ["self_preservation", "expansionism", "self_interest", "justice"];
