/**
 * openBrowserUrl with the real `open` package, bundled by esbuild to CommonJS
 * as the build does, against a fake xdg-open(1); an SSH session makes `open`
 * use xdg-open on WSL as well (is-in-ssh: SSH_CONNECTION).
 */
import { execFileSync } from 'child_process';
import { build } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SIGN_IN_URL = 'https://account.proton.me/desktop/login?app=drive&pv=3#payload=0%3AAB%3Aexternal-drive';

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('openBrowserUrl bundled with open', () => {
  let dir: string;
  let bundle: string;
  let fakeBin: string;
  let emptyBin: string;
  let received: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-browser-bundle-'));
    bundle = path.join(dir, 'run.cjs');
    fakeBin = path.join(dir, 'bin');
    emptyBin = path.join(dir, 'empty');
    received = path.join(dir, 'received');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(emptyBin);
    fs.writeFileSync(path.join(fakeBin, 'xdg-open'), '#!/bin/sh\nprintf %s "$1" > "$FAKE_RECEIVED"\nexit "$FAKE_EXIT"\n', { mode: 0o755 });
    await build({
      stdin: {
        contents: `const { openBrowserUrl } = require(${JSON.stringify(path.join(__dirname, 'open-browser.ts'))});
openBrowserUrl(process.argv[2]).then((opened) => process.stdout.write(JSON.stringify(opened)));`,
        resolveDir: __dirname,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: bundle,
      logLevel: 'silent',
    });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(binDir: string, exitStatus: number): boolean {
    const output = execFileSync(process.execPath, [bundle, SIGN_IN_URL], {
      env: {
        PATH: binDir,
        HOME: dir,
        SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22',
        FAKE_RECEIVED: received,
        FAKE_EXIT: String(exitStatus),
      },
      encoding: 'utf8',
    });
    return JSON.parse(output) as boolean;
  }

  it('hands xdg-open the whole URL and reports its exit status 0 as opened', () => {
    expect(run(fakeBin, 0)).toBe(true);
    expect(fs.readFileSync(received, 'utf8')).toBe(SIGN_IN_URL);
  });

  it('reports a failing xdg-open as not opened', () => {
    expect(run(fakeBin, 3)).toBe(false);
  });

  it('reports a missing xdg-open as not opened', () => {
    expect(run(emptyBin, 0)).toBe(false);
  });
});
