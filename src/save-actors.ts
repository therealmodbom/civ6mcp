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

// Below this a save cannot be complete; see readActors for why it matters.
const MIN_PARSEABLE_SAVE_BYTES = 200_000;

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
  /**
   * Player id, the same id Game_PlayerScores.csv writes in its Player column. A
   * civ's position in the save's CIVS list is that id, so only the major civs
   * listed there have one: the city-states in ACTORS are in no particular order.
   */
  playerId?: number;
}

const require = createRequire(import.meta.url);
let saveParser: typeof import('civ6-save-parser') | null = null;

/**
 * civ6-save-parser runs a CLI block guarded by `!module.parent`, which prints a
 * usage line to stdout — on a stdio MCP server that lands in the JSON-RPC stream
 * and breaks every client.
 *
 * `createRequire` already avoids it: on that path `module.parent` is set, so the
 * block never runs. The stdout mute stays as defence in depth, because
 * `module.parent` is deprecated and a future Node could leave it unset. It only
 * covers stdout, though — a CLI block that did run with a positional argument
 * would throw from `readFileSync` inside `require`, which the mute cannot help.
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
  // civ6-save-parser does not terminate on a truncated save: the CIV6 magic bytes
  // pass first, and the walk over actor records then runs forever. Measured on a
  // 1.7 MB save cut down — 60 kB and 85 kB never returned, 100 kB and up parsed in
  // milliseconds. The smallest real save observed is 824 kB, so this threshold
  // rejects only files that cannot be complete: an autosave still being written,
  // an interrupted copy, a cloud placeholder. A running loop cannot be caught, so
  // it has to be refused before the call.
  if (buffer.length < MIN_PARSEABLE_SAVE_BYTES) {
    console.error(`Save file too small to parse (${buffer.length} bytes) — still being written?`);
    return [];
  }

  try {
    const parsed = loadSaveParser().parse(buffer).parsed;
    // The index into CIVS is the player id; ACTORS entries carry no id at all.
    const slots: Array<[(typeof parsed.CIVS)[number], number | undefined]> = [
      ...(parsed.CIVS ?? []).map((c, i): [typeof c, number] => [c, i]),
      ...(parsed.ACTORS ?? []).map((c): [typeof c, undefined] => [c, undefined]),
    ];
    const actors = slots
      .filter(([c]) =>
        c.ACTOR_NAME?.data &&
        c.ACTOR_TYPE?.data?.startsWith('CIVILIZATION_LEVEL_') &&
        c.ACTOR_AI_HUMAN?.data !== ACTOR_SLOT_INACTIVE
      )
      .map(([c, playerId]) => ({
        civilization: c.ACTOR_NAME!.data.replace(/^CIVILIZATION_/, ''),
        leader: (c.LEADER_NAME?.data ?? '').replace(/^LEADER_/, ''),
        isHuman: c.ACTOR_AI_HUMAN?.data === ACTOR_HUMAN,
        isFullCiv: c.ACTOR_TYPE!.data === 'CIVILIZATION_LEVEL_FULL_CIV',
        playerId,
      }));

    // A civilization can appear in both collections; CIVS is listed first and wins
    const byCiv = new Map<string, SaveActor>();
    for (const actor of actors) {
      if (!byCiv.has(actor.civilization)) byCiv.set(actor.civilization, actor);
    }
    return [...byCiv.values()];
  } catch (error) {
    // Every caller falls back to a guess without these records, so say so —
    // silence here looks exactly like the bug this module was written to fix.
    console.error('Could not read actor records from save:', error);
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

/**
 * Whether the current save can speak for the game these logs describe. Player ids and
 * scores are joined through the save's slot order, so a missing save — or the newest
 * save belonging to a different game, which happens as soon as the saves tree holds
 * more than one — joins nothing. The result then looks exactly like a real one: every
 * score reads 0 and the human's row disappears. Callers state this condition in their
 * output instead of returning those numbers as if they were measured.
 *
 * `loggedCivs` are the raw civilization names the logs contain, without the
 * `CIVILIZATION_` prefix. Returns the condition, or null when the save fits.
 */
export function saveMismatchWarning(loggedCivs: Set<string>): string | null {
  const actors = getCurrentGameActors();
  if (actors.length === 0) {
    return 'no readable Civ 6 save was found';
  }

  const missing = actors
    .filter(a => a.playerId !== undefined && !loggedCivs.has(a.civilization))
    .map(a => a.civilization);
  if (missing.length === 0) return null;

  return `the newest save is a different game than these logs (it plays ${missing.join(', ')}, which the logs never mention)`;
}
