/**
 * local-peer.js — WebSocket relay drop-in for PeerJS (LAN play)
 *
 * Implements the subset of the PeerJS API used by host.js and player.js:
 *   peer.on('open' | 'connection' | 'error' | 'disconnected')
 *   conn.on('open' | 'data' | 'close' | 'error')
 *   conn.send(data)   conn.peer (remote id string)   conn.open (bool)
 *   peer.destroy()    peer.reconnect()   peer.connect(roomId)  ← player side
 *
 * Requires server.js running locally (serves /ws WebSocket endpoint).
 * On GitHub Pages location.hostname is 'nksimmons.github.io' — isLanMode()
 * returns false and this library is never used.
 */
(function () {
  'use strict';

  // ── Tiny event emitter ──────────────────────────────────────────────
  function Emitter() { this._h = Object.create(null); }
  Emitter.prototype.on = function (e, fn) { this._h[e] = fn; return this; };
  Emitter.prototype._fire = function (e) {
    if (this._h[e]) this._h[e].apply(null, Array.prototype.slice.call(arguments, 1));
  };

  // ── Host-side peer ──────────────────────────────────────────────────
  // Connects to ws://HOST/ws, registers as host, gets a room id,
  // and surfaces PeerJS-style 'connection' events for each joining player.
  function LocalHostPeer() {
    Emitter.call(this);
    this.id = null;
    this._ws = null;
    this._conns = Object.create(null); // cid → LocalHostConn
    var self = this;
    var ws = new WebSocket('ws://' + location.host + '/ws');
    this._ws = ws;
    ws.onopen = function () { ws.send(JSON.stringify({ t: 'host' })); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === 'ready') {
        self.id = m.id;
        self._fire('open', m.id);
      } else if (m.t === 'join') {
        var conn = new LocalHostConn(ws, m.cid);
        self._conns[m.cid] = conn;
        self._fire('connection', conn);
        // Fire conn 'open' on next tick so caller can register listeners first
        setTimeout(function () { conn._fire('open'); }, 0);
      } else if (m.t === 'msg') {
        var c = self._conns[m.cid];
        if (c) c._fire('data', m.d);
      } else if (m.t === 'leave') {
        var c2 = self._conns[m.cid];
        if (c2) { c2.open = false; c2._fire('close'); delete self._conns[m.cid]; }
      }
    };
    ws.onerror = function () { self._fire('error', new Error('WebSocket error')); };
    ws.onclose = function () { self._fire('disconnected'); };
  }
  LocalHostPeer.prototype = Object.create(Emitter.prototype);
  LocalHostPeer.prototype.destroy = function () { if (this._ws) this._ws.close(); };
  LocalHostPeer.prototype.reconnect = function () {};

  // Host-side connection to one player
  function LocalHostConn(ws, cid) {
    Emitter.call(this);
    this._ws = ws;
    this.peer = cid;   // matches PeerJS conn.peer
    this.open = true;
  }
  LocalHostConn.prototype = Object.create(Emitter.prototype);
  LocalHostConn.prototype.send = function (data) {
    if (this._ws && this._ws.readyState === 1 /* OPEN */) {
      this._ws.send(JSON.stringify({ t: 'send', cid: this.peer, d: data }));
    }
  };

  // ── Player-side peer ────────────────────────────────────────────────
  // Connects to ws://HOST/ws immediately (fires 'open' when ready),
  // then peer.connect() registers as a player and returns a conn.
  function LocalPlayerPeer() {
    Emitter.call(this);
    this.id = 'lp-' + Math.random().toString(36).slice(2, 9);
    this._ws = null;
    this._conn = null;
    var self = this;
    var ws = new WebSocket('ws://' + location.host + '/ws');
    this._ws = ws;
    ws.onopen = function () { self._fire('open', self.id); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === 'msg' && self._conn) self._conn._fire('data', m.d);
    };
    ws.onerror = function () { self._fire('error', new Error('WebSocket error')); };
    ws.onclose = function () {
      if (self._conn) { self._conn.open = false; self._conn._fire('close'); }
    };
  }
  LocalPlayerPeer.prototype = Object.create(Emitter.prototype);
  LocalPlayerPeer.prototype.connect = function (_roomId, _opts) {
    // roomId is ignored — there's only one host on this server
    var conn = new LocalPlayerConn(this._ws);
    this._conn = conn;
    this._ws.send(JSON.stringify({ t: 'player' }));
    setTimeout(function () { conn._fire('open'); }, 0);
    return conn;
  };
  LocalPlayerPeer.prototype.destroy = function () { if (this._ws) this._ws.close(); };

  // Player-side connection to the host
  function LocalPlayerConn(ws) {
    Emitter.call(this);
    this._ws = ws;
    this.peer = 'host';
    this.open = true;
  }
  LocalPlayerConn.prototype = Object.create(Emitter.prototype);
  LocalPlayerConn.prototype.send = function (data) {
    if (this._ws && this._ws.readyState === 1 /* OPEN */) {
      this._ws.send(JSON.stringify({ t: 'msg', d: data }));
    }
  };

  // ── LAN detection ───────────────────────────────────────────────────
  // Returns true when running through the local game server (not GitHub Pages).
  window.isLanMode = function () {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h);
  };

  window.LocalHostPeer = LocalHostPeer;
  window.LocalPlayerPeer = LocalPlayerPeer;
}());
