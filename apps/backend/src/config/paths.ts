import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { APP_IDENTIFIER } from '@aap/shared';

/** The per-user data root the OS expects apps to use. Same rules as Tauri's `appDataDir()`. */
export function osAppDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') return env.APPDATA ?? win32.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support');
  const xdg = env.XDG_DATA_HOME;
  return xdg !== undefined && posix.isAbsolute(xdg) ? xdg : posix.join(home, '.local', 'share');
}

/**
 * Where the backend keeps its database when AAP_DATA_DIR is not set: the app's data
 * directory, in a `dev` subfolder. The desktop app will pass its own data directory
 * explicitly, so standalone development runs never touch an installed app's data.
 */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.join(osAppDataRoot(platform, env, home), APP_IDENTIFIER, 'dev');
}
