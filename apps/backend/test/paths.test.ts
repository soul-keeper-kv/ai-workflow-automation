import { readFileSync } from 'node:fs';
import { APP_IDENTIFIER } from '@aap/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config/env.js';
import { defaultDataDir, osAppDataRoot } from '../src/config/paths.js';

describe('data directory', () => {
  it('follows the OS convention for app data', () => {
    expect(
      osAppDataRoot('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'),
    ).toBe('C:\\Users\\u\\AppData\\Roaming');
    expect(osAppDataRoot('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support');
    expect(osAppDataRoot('linux', {}, '/home/u')).toBe('/home/u/.local/share');
    expect(osAppDataRoot('linux', { XDG_DATA_HOME: '/data' }, '/home/u')).toBe('/data');
    expect(osAppDataRoot('linux', { XDG_DATA_HOME: 'relative' }, '/home/u')).toBe(
      '/home/u/.local/share',
    );
  });

  it('keeps standalone dev runs in a dev subfolder of the app directory', () => {
    expect(defaultDataDir('linux', {}, '/home/u')).toBe(
      `/home/u/.local/share/${APP_IDENTIFIER}/dev`,
    );
  });

  it('uses AAP_DATA_DIR when set, as an absolute path', () => {
    const config = loadConfig({ AAP_DATA_DIR: 'relative/data', AAP_API_TOKEN: 't'.repeat(32) });

    expect(config.dataDir).toMatch(/relative[\\/]data$/);
    expect(config.dataDir).not.toBe('relative/data');
  });

  it('uses the same identifier as the Tauri app', () => {
    const tauriConfig = z
      .object({ identifier: z.string() })
      .parse(
        JSON.parse(
          readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
        ),
      );

    expect(tauriConfig.identifier).toBe(APP_IDENTIFIER);
  });
});
