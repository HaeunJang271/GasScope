import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(publicDir, { recursive: true });
const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
const shim = join(goroot, 'lib', 'wasm', 'wasm_exec.js');
copyFileSync(existsSync(shim) ? shim : join(goroot, 'misc', 'wasm', 'wasm_exec.js'), join(publicDir, 'wasm_exec.js'));
execFileSync('go', ['build', '-o', join(publicDir, 'profile.wasm'), './cmd/browser'], {
  cwd: root, env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
