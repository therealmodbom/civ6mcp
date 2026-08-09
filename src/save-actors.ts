/**
 * Actor records from Civ 6 save files.
 *
 * The save carries the game's own classification of every player: whether it is a
 * full civilization or a city-state, and whether it is human or AI. The CSV logs
 * carry neither, so both the save parser and the log parser read it from here
 * rather than guessing from names.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { getSavesDirectory } from './paths.js';

// ACTOR_AI_HUMAN values used by the save format: 3 = human, 1 = AI.
// 2 marks a slot that is not a live player — civ6-save-parser skips those when it
// builds CIVS, and a save can carry such a duplicate entry for the human's civ.
const ACTOR_HUMAN = 3;
const ACTOR_SLOT_INACTIVE = 2;

/**
 * Fallback classification for when no save is readable. The actor records are the
 * real source — this list only keeps rankings roughly sane in the meantime, and it
 * cannot be complete: every expansion adds city-states.
 */
const KNOWN_CITY_STATES = new Set([
  'AKKAD', 'ANTANANARIVO', 'ANTIOCH', 'ARMAGH', 'AUCKLAND', 'AYUTTHAYA', 'BABYLON',
  'BANDAR_BRUNEI', 'BOLOGNA', 'BRUSSELS', 'BUENOS_AIRES', 'CAGUANA', 'CAHOKIA',
  'CARDIFF', 'CHINGUETTI', 'FEZ', 'GENEVA', 'GRANADA', 'HATTUSA', 'HONG_KONG',
  'HUNZA', 'JAKARTA', 'JERUSALEM', 'JOHANNESBURG', 'KABUL', 'KANDY', 'KUMASI',
  'LA_VENTA', 'LAHORE', 'LISBON', 'MEXICO_CITY', 'MITLA', 'MOGADISHU',
  'MOHENJO_DARO', 'MUSCAT', 'NALANDA', 'NAN_MADOL', 'NAZCA', 'NGAZARGAMU',
  'PALENQUE', 'PRESLAV', 'RAPA_NUI', 'SAMARKAND', 'SINGAPORE', 'TARUGA', 'TORONTO',
  'VALLETTA', 'VATICAN_CITY', 'VILNIUS', 'WOLIN', 'YEREVAN', 'ZANZIBAR',
]);

/** Name-based fallback; prefer an actor's `isFullCiv` whenever a save is available. */
export function isKnownCityStateName(civName: string): boolean {
  return KNOWN_CITY_STATES.has(civName) || civName === 'FREE_CITIES';
}

export interface SaveActor {
  /** Civilization name without the CIVILIZATION_ prefix, e.g. ROME */
  civilization: string;
  /** Leader name without the LEADER_ prefix, e.g. TRAJAN */
  leader: string;
  isHuman: boolean;
  /** True only for CIVILIZATION_LEVEL_FULL_CIV — city-states, free cities and barbarians are not */
  isFullCiv: boolean;
}

const require = createRequire(import.meta.url);
let saveParser: typeof import('civ6-save-parser') | null = null;

/**
 * civ6-save-parser guards its CLI block with `!module.parent`, which is true when
 * a CJS package is loaded from ESM — so merely importing it prints a usage line to
 * stdout. On a stdio MCP server that lands in the JSON-RPC stream and breaks every
 * client, so stdout is muted for the duration of the load.
 */
function loadSaveParser(): typeof import('civ6-save-parser') {
  if (!saveParser) {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      saveParser = require('civ6-save-parser');
    } finally {
      process.stdout.write = write;
    }
  }
  return saveParser!;
}

export function readActors(buffer: Buffer): SaveActor[] {
  try {
    const parsed = loadSaveParser().parse(buffer).parsed;
    const actors = [...(parsed.CIVS ?? []), ...(parsed.ACTORS ?? [])]
      .filter(c =>
        c.ACTOR_NAME?.data &&
        c.ACTOR_TYPE?.data?.startsWith('CIVILIZATION_LEVEL_') &&
        c.ACTOR_AI_HUMAN?.data !== ACTOR_SLOT_INACTIVE
      )
      .map(c => ({
        civilization: c.ACTOR_NAME!.data.replace(/^CIVILIZATION_/, ''),
        leader: (c.LEADER_NAME?.data ?? '').replace(/^LEADER_/, ''),
        isHuman: c.ACTOR_AI_HUMAN?.data === ACTOR_HUMAN,
        isFullCiv: c.ACTOR_TYPE!.data === 'CIVILIZATION_LEVEL_FULL_CIV',
      }));

    // A civilization can appear in both collections; CIVS is listed first and wins
    const byCiv = new Map<string, SaveActor>();
    for (const actor of actors) {
      if (!byCiv.has(actor.civilization)) byCiv.set(actor.civilization, actor);
    }
    return [...byCiv.values()];
  } catch {
    return [];
  }
}

function findNewestSave(): { path: string; mtimeMs: number } | null {
  let newest: { path: string; mtimeMs: number } | null = null;

  const scan = (dir: string, depth = 0) => {
    if (depth > 2) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          scan(full, depth + 1);
        } else if (entry.name.endsWith('.Civ6Save')) {
          const { mtimeMs } = statSync(full);
          if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
        }
      }
    } catch {
      // Directory missing or unreadable
    }
  };

  scan(join(getSavesDirectory(), 'Single'));
  return newest;
}

let cache: { path: string; mtimeMs: number; actors: SaveActor[] } | null = null;

/**
 * Actors of the most recently written save. Civ 6 writes an autosave every turn,
 * so this tracks the running game. Returns an empty list when no save is readable.
 */
export function getCurrentGameActors(): SaveActor[] {
  const newest = findNewestSave();
  if (!newest) return [];

  if (!cache || cache.path !== newest.path || cache.mtimeMs !== newest.mtimeMs) {
    cache = { ...newest, actors: readActors(readFileSync(newest.path)) };
  }
  return cache.actors;
}
