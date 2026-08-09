import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

function getWindowsLocalAppDataDirectory(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

/**
 * Get the Civilization VI saves directory for the current platform.
 */
export function getSavesDirectory(): string {
  if (platform() === 'win32') {
    return join(homedir(), 'Documents', 'My Games', "Sid Meier's Civilization VI", 'Saves');
  }
  // macOS
  return join(homedir(), 'Library', 'Application Support', "Sid Meier's Civilization VI", "Sid Meier's Civilization VI", 'Saves');
}

/**
 * Get the Civilization VI logs directory for the current platform.
 */
export function getLogsDirectory(): string {
  if (platform() === 'win32') {
    return join(getWindowsLocalAppDataDirectory(), 'Firaxis Games', "Sid Meier's Civilization VI", 'Logs');
  }
  // macOS
  return join(homedir(), 'Library', 'Application Support', "Sid Meier's Civilization VI", 'Firaxis Games', "Sid Meier's Civilization VI", 'Logs');
}

/**
 * Get the UserOptions.txt path for the current platform (used in error messages).
 *
 * Civ VI has moved this file between updates, so several locations are in the wild.
 * Return whichever exists; fall back to the first candidate when none do, so the
 * message still names a plausible path.
 */
export function getUserOptionsPath(): string {
  const appSupport = join(homedir(), 'Library', 'Application Support');
  const candidates = platform() === 'win32'
    ? [
        join(getWindowsLocalAppDataDirectory(), 'Firaxis Games', "Sid Meier's Civilization VI", 'UserOptions.txt'),
        // Older layout — still the saves root, see getSavesDirectory()
        join(homedir(), 'Documents', 'My Games', "Sid Meier's Civilization VI", 'UserOptions.txt'),
      ]
    : [
        // Current layout — same nesting the logs directory uses
        join(appSupport, "Sid Meier's Civilization VI", 'Firaxis Games', "Sid Meier's Civilization VI", 'UserOptions.txt'),
        // The path this function used before, kept for older installs
        join(appSupport, "Sid Meier's Civilization VI", 'UserOptions.txt'),
      ];

  return candidates.find(existsSync) ?? candidates[0];
}
