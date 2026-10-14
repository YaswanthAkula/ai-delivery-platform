import { spawn } from 'node:child_process';
import { AppError } from './memory.mjs';

// Never forward backend/model/runtime secrets to repository-controlled commands.
export function commandEnvironment(source = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME'].filter(key => source[key]).map(key => [key, source[key]]));
}
export function runCommand(argv, { cwd, env = commandEnvironment(), input, timeoutMs = 120000, maxBytes = 2000000, binary = false } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw new AppError(400, 'INVALID_COMMAND', 'Command must be an argument array');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let bytes = 0; let failure;
    function stop(code) {
      if (failure) return;
      failure = new AppError(502, code, 'Execution failed or exceeded its configured limits');
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Process already exited. */ }
    }
    const timer = setTimeout(() => stop('COMMAND_TIMEOUT'), timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) stop('COMMAND_OUTPUT_LIMIT'); else chunks.push(chunk); });
    child.once('error', () => { clearTimeout(timer); reject(new AppError(503, 'EXECUTABLE_UNAVAILABLE', 'Configured executable is unavailable')); });
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout: binary ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }); });
    child.stdin.on('error', () => {}); child.stdin.end(input ?? '');
  });
}
