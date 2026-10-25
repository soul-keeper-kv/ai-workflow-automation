import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/** How to start a program without a shell: the executable plus arguments that come first. */
export interface ResolvedCommand {
  executable: string;
  prefixArgs: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  if (!isFile(path)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads an npm cmd-shim (`name.cmd`) and returns what it runs. Node refuses to spawn `.cmd`
 * files without a shell, and a shell would parse untrusted arguments, so the shim's target
 * is started directly instead.
 */
export function parseCmdShim(shimPath: string, nodePath: string): ResolvedCommand | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const base = dirname(shimPath);
  const targets = [...text.matchAll(/"%(?:~)?dp0%\\?([^"]+\.(?:exe|js|cjs|mjs))"/gi)]
    .map((match) => match[1])
    .filter((target): target is string => target !== undefined)
    .map((target) => resolve(base, target));
  const target = targets.find(isFile);
  if (target === undefined) return null;
  return target.toLowerCase().endsWith('.exe')
    ? { executable: target, prefixArgs: [] }
    : { executable: nodePath, prefixArgs: [target] };
}

/**
 * Finds `name` on PATH. On Windows it prefers `name.exe`, then follows `name.cmd` shims to
 * their real target. Returns null when nothing usable is found.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  nodePath: string = process.execPath,
): ResolvedCommand | null {
  if (isAbsolute(name)) {
    if (process.platform === 'win32' && name.toLowerCase().endsWith('.cmd')) {
      return parseCmdShim(name, nodePath);
    }
    return isExecutable(name) ? { executable: name, prefixArgs: [] } : null;
  }

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir !== '');
  if (process.platform === 'win32') {
    for (const dir of dirs) {
      const exe = join(dir, `${name}.exe`);
      if (isFile(exe)) return { executable: exe, prefixArgs: [] };
    }
    for (const dir of dirs) {
      const shim = join(dir, `${name}.cmd`);
      if (isFile(shim)) {
        const resolved = parseCmdShim(shim, nodePath);
        if (resolved !== null) return resolved;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return { executable: candidate, prefixArgs: [] };
  }
  return null;
}
