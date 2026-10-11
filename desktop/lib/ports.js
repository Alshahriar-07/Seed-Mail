'use strict';

// Small helper for picking loopback ports for the desktop runtime.
//
// Two processes need a port each (the bundled worker and the local UI server),
// and neither is a fixed number: another copy of the app, or an unrelated
// program, may already hold 8765. Asking the operating system for a free port
// and binding it immediately afterwards is the only honest way to avoid a
// collision — a hardcoded port would fail on the user's machine, not in CI.

const net = require('node:net');

/**
 * Returns a currently free TCP port on the loopback interface.
 *
 * The socket is closed before the port is returned, so there is a small window
 * in which something else could take it. Callers bind immediately, and the
 * worker/health checks report a real failure if that ever happens — they never
 * pretend the service is up.
 */
function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = { getFreePort };
