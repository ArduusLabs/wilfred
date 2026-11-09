'use strict';

// Wilfred never talks to the network. This module makes that a hard rule at runtime rather than
// a promise: it is loaded first, and from then on every way this process could open a connection
// or look up a host name throws instead. Local pipes (how Electron and Node talk to themselves)
// still work, so nothing Wilfred legitimately does is affected.
//
// The Chromium side (the page) is locked separately in main.js: no network in its content
// security policy, every web request cancelled, and host-name resolution switched off.

const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');

class NetworkBlockedError extends Error {
  constructor(what) {
    super(`Wilfred has no network access (blocked: ${what})`);
    this.code = 'WILFRED_NETWORK_BLOCKED';
  }
}

const blocked = (what) => () => {
  throw new NetworkBlockedError(what);
};

// A local pipe is a path (Windows named pipe or Unix socket), never a host and port.
function isLocalPipe(args) {
  const [first] = args;
  if (typeof first === 'string') return Number.isNaN(Number(first));
  if (Array.isArray(first)) return isLocalPipe(first);
  return !!(first && typeof first === 'object' && typeof first.path === 'string' && first.port === undefined && first.host === undefined);
}

/**
 * Locks this process out of the network. Returns a function that undoes it (for tests only).
 * @param {object} [scope] where `fetch` and `WebSocket` live (globalThis by default)
 */
// Sets a property, even a read-only one (in strict mode a failed assignment throws, so it is caught).
function put(obj, key, value) {
  try {
    obj[key] = value;
  } catch {
    Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  }
}

function lockNetwork(scope = globalThis) {
  const saved = [];
  const replace = (obj, key, value) => {
    if (!obj || !(key in obj)) return;
    saved.push([obj, key, obj[key]]);
    put(obj, key, value);
  };

  const connect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, 'connect', function connectLocalOnly(...args) {
    if (!isLocalPipe(args)) throw new NetworkBlockedError('TCP connection');
    return connect.apply(this, args);
  });
  const listen = net.Server.prototype.listen;
  replace(net.Server.prototype, 'listen', function listenLocalOnly(...args) {
    if (!isLocalPipe(args)) throw new NetworkBlockedError('listening on a port');
    return listen.apply(this, args);
  });

  replace(tls, 'connect', blocked('TLS connection'));
  replace(dgram, 'createSocket', blocked('UDP socket'));
  for (const fn of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'resolveCaa', 'reverse']) {
    replace(dns, fn, blocked(`DNS ${fn}`));
    replace(dns.promises, fn, blocked(`DNS ${fn}`));
  }
  replace(dns, 'Resolver', function Resolver() {
    throw new NetworkBlockedError('DNS resolver');
  });
  for (const mod of [http, https]) {
    replace(mod, 'request', blocked('HTTP request'));
    replace(mod, 'get', blocked('HTTP request'));
  }
  replace(http2, 'connect', blocked('HTTP/2 connection'));
  replace(scope, 'fetch', blocked('fetch'));
  replace(scope, 'WebSocket', function WebSocket() {
    throw new NetworkBlockedError('WebSocket');
  });
  replace(scope, 'EventSource', function EventSource() {
    throw new NetworkBlockedError('EventSource');
  });

  return function unlock() {
    for (const [obj, key, value] of saved.reverse()) put(obj, key, value);
  };
}

/**
 * Tries each way out and reports which were refused. No packet can leave: every attempt is
 * stopped inside this process before a socket or DNS query exists.
 * @returns {{blocked: string[], open: string[]}}
 */
function verifyNetworkLocked(scope = globalThis, attempts = defaultAttempts(scope)) {
  const result = { blocked: [], open: [] };
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      const handle = attempt();
      result.open.push(name);
      if (handle && typeof handle.destroy === 'function') handle.destroy();
      if (handle && typeof handle.close === 'function') handle.close();
      if (handle && typeof handle.catch === 'function') handle.catch(() => {});
    } catch (e) {
      (e && e.code === 'WILFRED_NETWORK_BLOCKED' ? result.blocked : result.open).push(name);
    }
  }
  return result;
}

// One try at each way out, aimed at a documentation-only address (RFC 5737) and name (RFC 2606).
function defaultAttempts(scope) {
  return {
    tcp: () => net.connect({ host: '192.0.2.1', port: 9 }),
    tls: () => tls.connect({ host: '192.0.2.1', port: 9 }),
    udp: () => dgram.createSocket('udp4'),
    dns: () => dns.lookup('example.invalid'),
    http: () => http.request('http://192.0.2.1:9/'),
    https: () => https.request('https://192.0.2.1:9/'),
    http2: () => http2.connect('http://192.0.2.1:9'),
    fetch: () => scope.fetch('http://192.0.2.1:9/'),
    listen: () => net.createServer().listen(0),
  };
}

// ---- Chromium (the page, and Electron's own network module) ----

// The only links Wilfred ever opens are the Claude app's own, and the project page, opened in your
// browser from About when you click it. Wilfred itself still never connects: the browser does.
const ALLOWED_EXTERNAL = /^claude:\/\/|^https:\/\/github\.com\/ArduusLabs\/wilfred(?:$|[/#?])/;
// The only things a page may load: its own files and inline data.
const LOCAL_URL = /^(file|data|devtools|chrome|blob):/i;

/**
 * Before the app is ready: every host name resolves to nothing, and anything that still tries
 * goes to a proxy that isn't there. Background services (updates, metrics, pings) are off.
 */
function lockChromiumSwitches(app) {
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.commandLine.appendSwitch('proxy-server', '127.0.0.1:9');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('no-pings');
}

/** Once ready: every request that isn't local is cancelled, and no permission is ever granted. */
function lockSession(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !LOCAL_URL.test(details.url) }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

module.exports = {
  lockNetwork, verifyNetworkLocked, isLocalPipe, NetworkBlockedError,
  lockChromiumSwitches, lockSession, ALLOWED_EXTERNAL, LOCAL_URL,
};
