import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = join(publicDir, 'profile.wasm');
const runtime = join(publicDir, 'wasm_exec.js');

function buildWasm() {
  let goroot;
  try {
    goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const missing = [binary, runtime].filter(file => {
      const asset = statSync(file, { throwIfNoEntry: false });
      return !asset?.isFile() || asset.size === 0;
    });
    if (missing.length) {
      throw new Error('Go is unavailable and prebuilt WASM assets are missing or empty: ' + missing.join(', '));
    }
    console.log('Go is unavailable. Using the prebuilt GasScope WASM assets.');
    return;
  }
  mkdirSync(publicDir, { recursive: true });
  const shim = join(goroot, 'lib', 'wasm', 'wasm_exec.js');
  execFileSync('go', ['build', '-o', binary, './cmd/browser'], {
    cwd: root, env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
  });
  copyFileSync(existsSync(shim) ? shim : join(goroot, 'misc', 'wasm', 'wasm_exec.js'), runtime);
}

buildWasm();
