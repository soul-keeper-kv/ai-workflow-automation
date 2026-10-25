import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathNotAllowedError, WorkspaceFilesystem } from '../src/index.js';

let base: string;
let root: string;
let outside: string;
let fs: WorkspaceFilesystem;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'aap-fs-'));
  root = join(base, 'workspace');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'app', 'src'), { recursive: true });
  mkdirSync(join(root, 'app', 'node_modules', 'lib'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'app', 'src', 'page.tsx'), 'export default function Page() {}');
  writeFileSync(join(root, 'app', 'src', 'util.ts'), 'export const x = 1;');
  writeFileSync(join(root, 'app', 'src', 'notes.txt'), 'ignored');
  writeFileSync(join(root, 'app', 'src', 'big.ts'), 'x'.repeat(5000));
  writeFileSync(join(root, 'app', 'node_modules', 'lib', 'index.ts'), 'skipped');
  writeFileSync(join(outside, 'secret.ts'), 'SECRET');
  fs = await WorkspaceFilesystem.create([root]);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const options = { extensions: ['.ts', '.tsx'], maxFiles: 50, maxFileBytes: 1000 };

describe('WorkspaceFilesystem', () => {
  it('refuses roots that do not exist', async () => {
    await expect(WorkspaceFilesystem.create([join(base, 'missing')])).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it('resolves directories inside the roots and refuses the rest', async () => {
    await expect(fs.resolveDirectory(join(root, 'app'))).resolves.toContain('app');
    await expect(fs.resolveDirectory(outside)).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(fs.resolveDirectory(join(root, '..', 'outside'))).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await expect(fs.resolveDirectory('relative/path')).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it('does not let a link inside the root reach outside it', async () => {
    const link = join(root, 'escape');
    symlinkSync(outside, link, 'junction');

    await expect(fs.resolveDirectory(link)).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(fs.readText(root, 'escape/secret.ts', 100)).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    const listed = await fs.listFiles(root, options);
    expect(listed.files.map((f) => f.path)).not.toContain('escape/secret.ts');
    expect(listed.skipped).toContainEqual({ path: 'escape', reason: 'symlink' });
  });

  it('lists matching files, skipping ignored folders and large files', async () => {
    const listed = await fs.listFiles(join(root, 'app'), options);

    expect(listed.files.map((f) => f.path)).toEqual(['src/page.tsx', 'src/util.ts']);
    expect(listed.skipped).toContainEqual({ path: 'src/big.ts', reason: 'too-large' });
    expect(listed.truncated).toBe(false);
  });

  it('stops at maxFiles and says so', async () => {
    const listed = await fs.listFiles(join(root, 'app'), { ...options, maxFiles: 1 });

    expect(listed.files).toHaveLength(1);
    expect(listed.truncated).toBe(true);
  });

  it('leaves out excluded folders', async () => {
    const listed = await fs.listFiles(join(root, 'app'), {
      ...options,
      excludePaths: [join(root, 'app', 'src')],
    });

    expect(listed.files).toEqual([]);
  });

  it('reads text within a directory, bounded, and refuses traversal', async () => {
    await expect(fs.readText(join(root, 'app'), 'src/util.ts', 6)).resolves.toBe('export');
    await expect(
      fs.readText(join(root, 'app'), '../../outside/secret.ts', 100),
    ).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it('creates output folders only inside the roots', async () => {
    const created = await fs.ensureOutputDirectory(join(root, 'out', 'specs'));

    expect(readdirSync(join(root, 'out'))).toEqual(['specs']);
    expect(created).toContain('specs');
    await expect(fs.ensureOutputDirectory(join(outside, 'specs'))).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it('writes files atomically, without leftovers, and only with plain names', async () => {
    const target = await fs.writeTextFile(root, 'spec.md', '# Spec', { overwrite: false });

    expect(readFileSync(target, 'utf8')).toBe('# Spec');
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await expect(
      fs.writeTextFile(root, 'spec.md', 'again', { overwrite: false }),
    ).rejects.toBeInstanceOf(PathNotAllowedError);
    await fs.writeTextFile(root, 'spec.md', 'again', { overwrite: true });
    expect(readFileSync(target, 'utf8')).toBe('again');
    for (const name of ['../x.md', 'a/b.md', '.env', '..']) {
      await expect(fs.writeTextFile(root, name, 'x', { overwrite: true })).rejects.toBeInstanceOf(
        PathNotAllowedError,
      );
    }
  });
});
