const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function prefixStream(name, stream, dest) {
  stream.on('data', (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    for (const line of lines) dest.write(`[${name}] ${line}\n`);
  });
}

function spawnProcess(cmd, args, cwd, name) {
  const command = `${cmd} ${args.map(a => String(a)).join(' ')}`;
  const child = spawn(command, {
    cwd,
    env: process.env,
    shell: true,
  });

  prefixStream(name, child.stdout, process.stdout);
  prefixStream(name, child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[${name}] exited by signal ${signal}`);
    } else {
      console.log(`[${name}] exited with code ${code}`);
    }
  });

  return child;
}

function waitForHealth(url, timeoutMs = 30000, intervalMs = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const tryOnce = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
        } else {
          retryOrFail();
        }
        res.resume();
      });
      req.on('error', retryOrFail);
      req.setTimeout(2000, () => req.abort());
    };

    const retryOrFail = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Timed out waiting for health endpoint'));
      } else {
        setTimeout(tryOnce, intervalMs);
      }
    };

    tryOnce();
  });
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const serverDir = path.join(repoRoot, 'server');
  const webDir = path.join(repoRoot, 'web');

  const serverPort = process.env.SERVER_PORT || process.env.PORT || '3001';
  const healthUrl = `http://127.0.0.1:${serverPort}/api/health`;

  const ensureInstalled = (dir) => {
    const fs = require('fs');
    const binPath = process.platform === 'win32' ? 'node_modules\\.bin\\tsx.cmd' : 'node_modules/.bin/tsx';
    if (!fs.existsSync(path.join(dir, binPath))) {
      console.log(`[installer] installing dependencies in ${dir} ...`);
      // use yarn for installs
      const installer = spawnProcess(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['install', '--silent', '--offline'], dir, 'installer');
      return new Promise((resolve, reject) => {
        installer.on('exit', (code) => {
          if (code === 0) resolve(); else reject(new Error('install failed'));
        });
      });
    }
    return Promise.resolve();
  };

  const runCommandAwait = (cmd, args, cwd, name) => {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(process.platform === 'win32' ? `${cmd}.cmd` : cmd, args, cwd, name);
      child.on('exit', (code) => {
        if (code === 0) resolve(); else reject(new Error(`${name} failed with code ${code}`));
      });
    });
  };

  console.log(`Preparing server in ${serverDir}`);
  await ensureInstalled(serverDir);
  // Ensure Prisma client generated if server expects it
  try {
    const fs = require('fs');
    const generatedClient = path.join(serverDir, 'prisma', 'generated', 'index.js');
    if (!fs.existsSync(generatedClient)) {
      console.log('[installer] prisma client not found, running `yarn prisma:generate`...');
      await runCommandAwait(process.platform === 'win32' ? 'yarn' : 'yarn', ['prisma:generate'], serverDir, 'prisma:generate');
      console.log('[installer] prisma:generate finished');
    }
  } catch (err) {
    console.error('[installer] prisma generate failed or was skipped:', err && err.message ? err.message : err);
  }
  console.log(`Starting server in ${serverDir}`);
  const server = spawnProcess(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['start'], serverDir, 'server');

  try {
    console.log(`Waiting for server health at ${healthUrl} ...`);
    await waitForHealth(healthUrl, 30000, 1000);
    console.log('Server is healthy — starting web');
  } catch (err) {
    console.error('Server did not become healthy in time:', err.message || err);
    console.error('Proceeding to start web anyway. You may want to check the server logs.');
  }

  console.log(`Preparing web in ${webDir}`);
  await ensureInstalled(webDir);
  console.log(`Starting web in ${webDir}`);
  const web = spawnProcess(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['start'], webDir, 'web');

  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down children...`);
    try { server.kill('SIGTERM'); } catch (e) {}
    try { web.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => process.exit(0), 2000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // If either process exits, shut down the other and exit with its code
  server.on('exit', (code) => {
    console.log(`[server] exit detected, shutting down web (if running)`);
    try { web.kill('SIGTERM'); } catch (e) {}
    process.exit(code === null ? 0 : code);
  });

  web.on('exit', (code) => {
    console.log(`[web] exit detected, shutting down server (if running)`);
    try { server.kill('SIGTERM'); } catch (e) {}
    process.exit(code === null ? 0 : code);
  });
}

main().catch((err) => {
  console.error('Failed to start both services:', err);
  process.exit(1);
});
