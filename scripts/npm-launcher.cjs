#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const manifest = require('../package.json');

const SCOPE = '@crewyard/cli-';
const platform = `${process.platform}-${process.arch}`;
const executable = process.platform === 'win32' ? 'crew.exe' : 'crew';

function resolveBinary() {
  try {
    return require.resolve(`${SCOPE}${platform}/bin/${executable}`);
  } catch {
    const supported = Object.keys(manifest.optionalDependencies || {})
      .map((name) => name.slice(SCOPE.length))
      .join(', ');
    process.stderr.write(
      `crew: no prebuilt binary is installed for ${platform}.\n` +
        `Supported platforms: ${supported}.\n` +
        'If yours is listed, reinstall without --omit=optional or --no-optional.\n',
    );
    process.exit(1);
  }
}

const child = spawn(resolveBinary(), process.argv.slice(2), { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGQUIT']) process.on(signal, () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));

child.on('error', (error) => {
  process.stderr.write(`crew: failed to start ${platform} binary: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
