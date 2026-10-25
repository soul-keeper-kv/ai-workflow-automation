import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A path outside every allowed workspace root, or otherwise refused. */
export class PathNotAllowedError extends Error {
  override readonly name = 'PathNotAllowedError';

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

export interface DiscoveredFile {
  /** Relative to the listed directory, with forward slashes. */
  path: string;
  bytes: number;
}

export interface ListFilesOptions {
  /** Lower-case extensions including the dot, e.g. `.ts`. */
  extensions: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  /** Directory names skipped wherever they appear. */
  ignoreDirectories?: readonly string[];
  /** Absolute directories to leave out, e.g. the output directory. */
  excludePaths?: readonly string[];
}

export interface ListFilesResult {
  files: DiscoveredFile[];
  skipped: { path: string; reason: 'too-large' | 'symlink' | 'limit' }[];
  /** Stopped early because `maxFiles` was reached. */
  truncated: boolean;
}

export const DEFAULT_IGNORED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'target',
  'vendor',
  '.venv',
  '__pycache__',
] as const;

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The only door workflows have to the disk. Every path is resolved through symlinks and must
 * stay inside one of the allowed roots (blueprint §15.3). Nothing outside them is read or
 * written, and symlinks are never followed during discovery.
 */
export class WorkspaceFilesystem {
  readonly #roots: string[];

  private constructor(roots: string[]) {
    this.#roots = roots;
  }

  /** Roots must exist; they are stored by their real path. */
  static async create(roots: readonly string[]): Promise<WorkspaceFilesystem> {
    const resolved: string[] = [];
    for (const root of roots) {
      if (!isAbsolute(root))
        throw new PathNotAllowedError(root, 'workspace roots must be absolute');
      const real = await realpath(root).catch(() => {
        throw new PathNotAllowedError(root, 'workspace root does not exist');
      });
      if (!(await stat(real)).isDirectory()) {
        throw new PathNotAllowedError(root, 'workspace root is not a directory');
      }
      resolved.push(real);
    }
    return new WorkspaceFilesystem(resolved);
  }

  get roots(): readonly string[] {
    return this.#roots;
  }

  #assertAllowed(real: string, original: string): void {
    if (!this.#roots.some((root) => isInside(real, root))) {
      throw new PathNotAllowedError(original, 'outside the allowed workspace folders');
    }
  }

  /** An existing directory inside a root, by its real path. */
  async resolveDirectory(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new PathNotAllowedError(path, 'must be an absolute path');
    const real = await realpath(path).catch(() => {
      throw new PathNotAllowedError(path, 'does not exist');
    });
    this.#assertAllowed(real, path);
    if (!(await stat(real)).isDirectory())
      throw new PathNotAllowedError(path, 'is not a directory');
    return real;
  }

  /**
   * A directory to write into, created if missing. The deepest part that already exists is
   * resolved through symlinks first, so a link cannot redirect the new folders elsewhere.
   */
  async ensureOutputDirectory(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new PathNotAllowedError(path, 'must be an absolute path');
    let existing = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try {
        await lstat(existing);
        break;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) throw new PathNotAllowedError(path, 'has no existing parent');
        missing.unshift(basename(existing));
        existing = parent;
      }
    }
    const real = join(await realpath(existing), ...missing);
    this.#assertAllowed(real, path);
    await mkdir(real, { recursive: true });
    return this.resolveDirectory(real);
  }

  /** Files under `directory` (a resolved directory), filtered and bounded. */
  async listFiles(directory: string, options: ListFilesOptions): Promise<ListFilesResult> {
    const root = await this.resolveDirectory(directory);
    const ignored = new Set(options.ignoreDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
    const excluded = options.excludePaths ?? [];
    const extensions = new Set(options.extensions.map((e) => e.toLowerCase()));
    const result: ListFilesResult = { files: [], skipped: [], truncated: false };

    const walk = async (dir: string): Promise<void> => {
      const entries = [];
      for await (const entry of await opendir(dir)) entries.push(entry);
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const full = join(dir, entry.name);
        const rel = relative(root, full).split(sep).join('/');
        if (entry.isSymbolicLink()) {
          result.skipped.push({ path: rel, reason: 'symlink' });
          continue;
        }
        if (entry.isDirectory()) {
          if (ignored.has(entry.name) || excluded.some((path) => isInside(full, path))) continue;
          await walk(full);
          if (result.truncated) return;
          continue;
        }
        if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue;
        if (result.files.length >= options.maxFiles) {
          result.truncated = true;
          result.skipped.push({ path: rel, reason: 'limit' });
          return;
        }
        const { size } = await stat(full);
        if (size > options.maxFileBytes) {
          result.skipped.push({ path: rel, reason: 'too-large' });
          continue;
        }
        result.files.push({ path: rel, bytes: size });
      }
    };

    await walk(root);
    return result;
  }

  /** Reads up to `maxBytes` of a text file under `directory`. */
  async readText(directory: string, relativePath: string, maxBytes: number): Promise<string> {
    const root = await this.resolveDirectory(directory);
    const target = resolve(root, relativePath);
    const real = await realpath(target).catch(() => {
      throw new PathNotAllowedError(relativePath, 'does not exist');
    });
    if (!isInside(real, root)) throw new PathNotAllowedError(relativePath, 'escapes the directory');
    this.#assertAllowed(real, relativePath);

    const handle = await open(real, constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes `content` to `directory/fileName` atomically: a temporary file in the same folder,
   * then a rename. `fileName` must be a plain name, without folders.
   */
  async writeTextFile(
    directory: string,
    fileName: string,
    content: string,
    options: { overwrite: boolean },
  ): Promise<string> {
    if (fileName !== basename(fileName) || fileName.startsWith('.') || fileName.includes('..')) {
      throw new PathNotAllowedError(fileName, 'must be a plain file name');
    }
    const dir = await this.resolveDirectory(directory);
    const target = join(dir, fileName);
    if (!options.overwrite) {
      const exists = await lstat(target).then(
        () => true,
        () => false,
      );
      if (exists) throw new PathNotAllowedError(target, 'already exists');
    }
    const temp = join(dir, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return target;
  }
}
