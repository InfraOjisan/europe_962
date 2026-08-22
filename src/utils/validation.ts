import type { GameState } from "../models/gameState.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * GameState の参照整合性を検証する。
 * データモデルは Record ベースで自由に組み立てられるため、
 * 「隣接関係が対称か」「参照している ID が実在するか」を
 * 実行時にチェックできるようにしておく（初期データ作成・セーブ復元時の事故防止）。
 */
export function validateGameState(state: GameState): ValidationResult {
  const issues: ValidationIssue[] = [];
  const regionIds = new Set(Object.keys(state.regions));
  const factionIds = new Set(Object.keys(state.factions));
  const armyIds = new Set(Object.keys(state.armies));
  const characterIds = new Set(Object.keys(state.characters));

  // --- Region ---
  for (const region of Object.values(state.regions)) {
    if (!factionIds.has(region.owner)) {
      issues.push({ path: `regions.${region.id}.owner`, message: `未知の勢力を領有者に指定: ${region.owner}` });
    }
    for (const neighborId of region.adjacency) {
      const neighbor = state.regions[neighborId];
      if (!neighbor) {
        issues.push({ path: `regions.${region.id}.adjacency`, message: `未知の隣接州: ${neighborId}` });
        continue;
      }
      if (!neighbor.adjacency.includes(region.id)) {
        issues.push({
          path: `regions.${region.id}.adjacency`,
          message: `隣接関係が非対称: ${region.id} -> ${neighborId} だが逆方向がない`,
        });
      }
    }
    if (region.siege && !armyIds.has(region.siege.attackerArmy)) {
      issues.push({ path: `regions.${region.id}.siege`, message: `未知の攻囲軍: ${region.siege.attackerArmy}` });
    }
  }

  // --- Faction ---
  for (const faction of Object.values(state.factions)) {
    if (faction.type === "mercenary" && faction.regions.length > 0) {
      issues.push({ path: `factions.${faction.id}.regions`, message: `傭兵団は領地を持てない` });
    }
    for (const regionId of faction.regions) {
      if (!regionIds.has(regionId)) {
        issues.push({ path: `factions.${faction.id}.regions`, message: `未知の州: ${regionId}` });
      } else if (state.regions[regionId]?.owner !== faction.id) {
        issues.push({
          path: `factions.${faction.id}.regions`,
          message: `${regionId} の owner が一致しない`,
        });
      }
    }
    const personIds = [faction.ruler, faction.consort, ...faction.chancellors, ...faction.warlords].filter(
      (id): id is NonNullable<typeof id> => id !== null,
    );
    for (const charId of personIds) {
      if (!characterIds.has(charId)) {
        issues.push({ path: `factions.${faction.id}`, message: `未知の人物: ${charId}` });
      }
    }
    if (faction.heir !== null) {
      const heir = state.characters[faction.heir];
      if (!heir) {
        issues.push({ path: `factions.${faction.id}.heir`, message: `未知の人物: ${faction.heir}` });
      } else if (heir.faction !== faction.id) {
        issues.push({ path: `factions.${faction.id}.heir`, message: `heir ${faction.heir} は自勢力の人物ではない` });
      }
    }
    for (const [otherId, stance] of Object.entries(faction.diplomacy)) {
      if (!factionIds.has(otherId)) {
        issues.push({ path: `factions.${faction.id}.diplomacy`, message: `未知の勢力: ${otherId} (${stance})` });
      }
    }
  }

  // --- Army ---
  for (const army of Object.values(state.armies)) {
    if (!factionIds.has(army.faction)) {
      issues.push({ path: `armies.${army.id}.faction`, message: `未知の勢力: ${army.faction}` });
    }
    if (!regionIds.has(army.location)) {
      issues.push({ path: `armies.${army.id}.location`, message: `未知の州: ${army.location}` });
    }
    if (army.commander !== null && !characterIds.has(army.commander)) {
      issues.push({ path: `armies.${army.id}.commander`, message: `未知の人物: ${army.commander}` });
    }
  }

  // --- Character ---
  for (const character of Object.values(state.characters)) {
    if (!factionIds.has(character.faction)) {
      issues.push({ path: `characters.${character.id}.faction`, message: `未知の勢力: ${character.faction}` });
    }
    for (const parentId of character.parents) {
      if (!characterIds.has(parentId)) {
        issues.push({ path: `characters.${character.id}.parents`, message: `未知の人物: ${parentId}` });
      }
    }
    for (const childId of character.adoptedChildren) {
      const child = state.characters[childId];
      if (!child) {
        issues.push({ path: `characters.${character.id}.adoptedChildren`, message: `未知の人物: ${childId}` });
      } else if (child.adoptedBy !== character.id) {
        issues.push({
          path: `characters.${character.id}.adoptedChildren`,
          message: `${childId}.adoptedBy が ${character.id} を指していない（片方向の不整合）`,
        });
      }
    }
    if (character.adoptedBy !== null) {
      const parent = state.characters[character.adoptedBy];
      if (!parent) {
        issues.push({ path: `characters.${character.id}.adoptedBy`, message: `未知の人物: ${character.adoptedBy}` });
      } else if (!parent.adoptedChildren.includes(character.id)) {
        issues.push({
          path: `characters.${character.id}.adoptedBy`,
          message: `${parent.id}.adoptedChildren が ${character.id} を含んでいない（片方向の不整合）`,
        });
      }
    }
  }

  // --- Captivity ---
  for (const [key, captivity] of Object.entries(state.captivities)) {
    if (key !== captivity.captive) {
      issues.push({ path: `captivities.${key}`, message: `キーと captive が一致しない: ${captivity.captive}` });
    }
    if (!characterIds.has(captivity.captive)) {
      issues.push({ path: `captivities.${key}.captive`, message: `未知の人物: ${captivity.captive}` });
    }
    if (!factionIds.has(captivity.captor)) {
      issues.push({ path: `captivities.${key}.captor`, message: `未知の勢力: ${captivity.captor}` });
    }
    if (!factionIds.has(captivity.homeFaction)) {
      issues.push({ path: `captivities.${key}.homeFaction`, message: `未知の勢力: ${captivity.homeFaction}` });
    }
    if (captivity.ransomDemand < 0) {
      issues.push({ path: `captivities.${key}.ransomDemand`, message: `身代金が負数: ${captivity.ransomDemand}` });
    }
  }

  return { valid: issues.length === 0, issues };
}
