// The encryption behind the home page's question box (ask.js), done here in
// the visitor's browser. A question is encrypted to the key of the sealed
// hardware the uncensored LLM runs in, which closedhand.com proved and gave
// this page, and the answer comes back encrypted to a key made here for that
// one question. closedhand.com carries both and can open neither.
//
// The format is the one every Closedhand uses (lib/near-private.js, E2EE v2):
// each field is hex of [ephemeral X25519 public key (32)][nonce (24)]
// [XChaCha20-Poly1305 ciphertext and tag], its key HKDF-SHA256 of the shared
// secret. X25519, ChaCha20 and Poly1305 are written out below, as browsers
// have no XChaCha20 and only recent ones X25519; the keys last one question,
// on the visitor's own device. test/ask.js checks every part against Node's.
(function (root) {
  'use strict';
  var subtle = root.crypto && root.crypto.subtle;
  var P = (1n << 255n) - 19n;
  function mod(a) { a %= P; return a < 0n ? a + P : a; }
  function pow(b, e) { var r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
  function inv(a) { return pow(a, P - 2n); }
  function fromLe(bytes) { var n = 0n; for (var i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; }
  function toLe(n, length) { var out = new Uint8Array(length); for (var i = 0; i < length; i++) { out[i] = Number(n & 255n); n >>= 8n; } return out; }
  function fromHex(hex) {
    if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('not hex');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function toHex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  function join() {
    var length = 0, i, at = 0;
    for (i = 0; i < arguments.length; i++) length += arguments[i].length;
    var out = new Uint8Array(length);
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], at); at += arguments[i].length; }
    return out;
  }
  function random(length) { var out = new Uint8Array(length); root.crypto.getRandomValues(out); return out; }

  // X25519 (RFC 7748): the Montgomery ladder.
  var BASE = new Uint8Array(32); BASE[0] = 9;
  function x25519(secret, point) {
    var k = secret.slice(); k[0] &= 248; k[31] &= 127; k[31] |= 64;
    var scalar = fromLe(k), x1 = fromLe(point) & ((1n << 255n) - 1n);
    var x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n, t;
    for (var bit = 254n; bit >= 0n; bit--) {
      var kt = (scalar >> bit) & 1n;
      if (swap ^ kt) { t = x2; x2 = x3; x3 = t; t = z2; z2 = z3; z3 = t; }
      swap = kt;
      var a = mod(x2 + z2), aa = a * a % P, b = mod(x2 - z2), bb = b * b % P, e = mod(aa - bb);
      var c = mod(x3 + z3), d = mod(x3 - z3), da = d * a % P, cb = c * b % P;
      x3 = mod(da + cb); x3 = x3 * x3 % P;
      z3 = mod(da - cb); z3 = x1 * (z3 * z3 % P) % P;
      x2 = aa * bb % P;
      z2 = e * mod(aa + 121665n * e) % P;
    }
    if (swap) { t = x2; x2 = x3; x3 = t; t = z2; z2 = z3; z3 = t; }
    return toLe(x2 * inv(z2) % P, 32);
  }
  // The key a field for an Ed25519 public key is encrypted to: u = (1 + y) / (1 - y).
  function edToX25519(edPub) {
    var y = fromLe(edPub) & ((1n << 255n) - 1n);
    return toLe(mod(1n + y) * inv(mod(1n - y)) % P, 32);
  }

  // ChaCha20 (RFC 8439) and HChaCha20 (draft-irtf-cfrg-xchacha, 2.2).
  function rounds(s) {
    function qr(a, b, c, d) {
      s[a] = (s[a] + s[b]) | 0; s[d] ^= s[a]; s[d] = (s[d] << 16) | (s[d] >>> 16);
      s[c] = (s[c] + s[d]) | 0; s[b] ^= s[c]; s[b] = (s[b] << 12) | (s[b] >>> 20);
      s[a] = (s[a] + s[b]) | 0; s[d] ^= s[a]; s[d] = (s[d] << 8) | (s[d] >>> 24);
      s[c] = (s[c] + s[d]) | 0; s[b] ^= s[c]; s[b] = (s[b] << 7) | (s[b] >>> 25);
    }
    for (var i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
  }
  function word(bytes, at) { return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24); }
  function start(key, last) {
    var s = new Int32Array(16), i;
    s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
    for (i = 0; i < 8; i++) s[4 + i] = word(key, i * 4);
    for (i = 0; i < 4; i++) s[12 + i] = last[i];
    return s;
  }
  function hchacha20(key, nonce16) {
    var s = start(key, [word(nonce16, 0), word(nonce16, 4), word(nonce16, 8), word(nonce16, 12)]);
    rounds(s);
    var out = new Uint8Array(32);
    [0, 1, 2, 3, 12, 13, 14, 15].forEach(function (w, i) { out[i * 4] = s[w] & 255; out[i * 4 + 1] = (s[w] >>> 8) & 255; out[i * 4 + 2] = (s[w] >>> 16) & 255; out[i * 4 + 3] = s[w] >>> 24; });
    return out;
  }
  function chacha20(key, counter, nonce12, data) {
    var out = new Uint8Array(data.length);
    for (var at = 0; at < data.length || (at === 0 && !data.length); at += 64, counter++) {
      var first = start(key, [counter, word(nonce12, 0), word(nonce12, 4), word(nonce12, 8)]), s = first.slice();
      rounds(s);
      for (var i = 0; i < 64 && at + i < data.length; i++) out[at + i] = data[at + i] ^ (((s[i >> 2] + first[i >> 2]) >>> ((i & 3) * 8)) & 255);
      if (!data.length) break;
    }
    return out;
  }
  // Poly1305 (RFC 8439, 2.5).
  function poly1305(key, message) {
    var r = fromLe(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn, s = fromLe(key.subarray(16, 32));
    var p = (1n << 130n) - 5n, acc = 0n;
    for (var at = 0; at < message.length; at += 16) {
      var block = message.subarray(at, Math.min(at + 16, message.length));
      acc = (acc + fromLe(block) + (1n << BigInt(8 * block.length))) * r % p;
    }
    return toLe((acc + s) & ((1n << 128n) - 1n), 16);
  }
  // XChaCha20-Poly1305: ciphertext and tag, with no additional data.
  function tag(subkey, nonce12, sealed) {
    var otk = chacha20(subkey, 0, nonce12, new Uint8Array(32));
    var pad = new Uint8Array((16 - sealed.length % 16) % 16);
    return poly1305(otk, join(sealed, pad, toLe(0n, 8), toLe(BigInt(sealed.length), 8)));
  }
  function xchachaSeal(key, nonce, plain) {
    var subkey = hchacha20(key, nonce.subarray(0, 16)), nonce12 = join(new Uint8Array(4), nonce.subarray(16, 24));
    var sealed = chacha20(subkey, 1, nonce12, plain);
    return join(sealed, tag(subkey, nonce12, sealed));
  }
  function xchachaOpen(key, nonce, data) {
    if (data.length < 16) throw new Error('ciphertext too short');
    var subkey = hchacha20(key, nonce.subarray(0, 16)), nonce12 = join(new Uint8Array(4), nonce.subarray(16, 24));
    var sealed = data.subarray(0, data.length - 16), given = data.subarray(data.length - 16), made = tag(subkey, nonce12, sealed), differ = 0;
    for (var i = 0; i < 16; i++) differ |= given[i] ^ made[i];
    if (differ) throw new Error('not what was sent');
    return chacha20(subkey, 1, nonce12, sealed);
  }

  function fieldKey(shared) {
    return subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']).then(function (key) {
      return subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('ed25519_encryption') }, key, 256);
    }).then(function (bits) { return new Uint8Array(bits); });
  }
  // One field, for the sealed hardware's Ed25519 public key (hex).
  function seal(text, recipientHex) {
    var secret = random(32), nonce = random(24);
    return fieldKey(x25519(secret, edToX25519(fromHex(recipientHex)))).then(function (key) {
      return toHex(join(x25519(secret, BASE), nonce, xchachaSeal(key, nonce, new TextEncoder().encode(String(text)))));
    });
  }
  // A key pair for one question. The public half goes with the question, as
  // the Ed25519 key that maps to this X25519 one (y = (u - 1) / (u + 1)), and
  // the answer is encrypted to it; the secret never leaves this page.
  function keys() {
    var secret = random(32), u = fromLe(x25519(secret, BASE));
    return { publicHex: toHex(toLe(mod(u - 1n) * inv(mod(u + 1n)) % P, 32)), secret: secret };
  }
  function open(hex, secret) {
    var data = fromHex(hex);
    if (data.length < 32 + 24 + 16) throw new Error('an encrypted field is too short');
    return fieldKey(x25519(secret, data.subarray(0, 32))).then(function (key) {
      return new TextDecoder().decode(xchachaOpen(key, data.subarray(32, 56), data.subarray(56)));
    });
  }

  var api = { seal: seal, open: open, keys: keys, ready: !!(subtle && root.TextEncoder),
    x25519: x25519, edToX25519: edToX25519, hchacha20: hchacha20, xchachaSeal: xchachaSeal, xchachaOpen: xchachaOpen, fromHex: fromHex, toHex: toHex };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.AskPrivate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
