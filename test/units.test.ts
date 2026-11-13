import test from "node:test";
import assert from "node:assert/strict";
import { createCode, redeemCode, pendingCodeCount, CODE_TTL_MS } from "../src/oauth/store.js";
import { secondsUntilExpiry } from "../src/oauth/jwt.js";
import { createRateLimiter } from "../src/oauth/rate-limit.js";
import type { Bucket } from "../src/oauth/rate-limit.js";
import { makeJwt } from "./helpers.js";

const entry = { jwt: "j", gocRefreshToken: "g", redirect_uri: "https://a.test/cb" };

test("store: el código es de un solo uso", () => {
  const code = createCode(entry);
  assert.ok(redeemCode(code, { redirect_uri: entry.redirect_uri }));
  assert.equal(redeemCode(code, { redirect_uri: entry.redirect_uri }), null);
});

test("store: un canje con redirect_uri distinta falla y también quema el código", () => {
  const code = createCode(entry);
  assert.equal(redeemCode(code, { redirect_uri: "https://evil.test/cb" }), null);
  assert.equal(redeemCode(code, { redirect_uri: entry.redirect_uri }), null);
});

test("store: el código vence a los 5 minutos", () => {
  const t0 = 1_000_000;
  const code = createCode(entry, t0);
  assert.equal(redeemCode(code, { redirect_uri: entry.redirect_uri }, t0 + CODE_TTL_MS + 1), null);
});

test("store: los códigos vencidos sin canjear se barren al crear otro", () => {
  const t0 = 2_000_000;
  createCode(entry, t0);
  const before = pendingCodeCount();
  createCode(entry, t0 + CODE_TTL_MS + 1);
  assert.ok(pendingCodeCount() <= before, "el vencido no debe acumularse");
  assert.equal(pendingCodeCount(), 1);
});

test("jwt: expires_in sale del exp real", () => {
  const now = 1_700_000_000_000;
  assert.equal(secondsUntilExpiry(makeJwt(now / 1000 + 5400), now), 5400);
});

test("jwt: sin exp, vencido o malformado devuelve undefined", () => {
  const now = 1_700_000_000_000;
  assert.equal(secondsUntilExpiry(makeJwt(null), now), undefined);
  assert.equal(secondsUntilExpiry(makeJwt(now / 1000 - 10), now), undefined);
  assert.equal(secondsUntilExpiry("no-es-jwt", now), undefined);
  assert.equal(secondsUntilExpiry("a.%%%.c", now), undefined);
});

test("rate-limit: permite hasta el máximo y bloquea el siguiente", () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 1000 });
  assert.equal(limiter.hit("ip", 0), null);
  assert.equal(limiter.hit("ip", 1), null);
  assert.equal(limiter.hit("ip", 2), null);
  assert.ok((limiter.hit("ip", 3) ?? 0) >= 1);
});

test("rate-limit: se reinicia al terminar la ventana y las claves son independientes", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
  assert.equal(limiter.hit("a", 0), null);
  assert.notEqual(limiter.hit("a", 10), null);
  assert.equal(limiter.hit("b", 10), null);
  assert.equal(limiter.hit("a", 1000), null);
});

test("rate-limit: el Map no pasa del tope con claves distintas y las nuevas se responden excedidas", () => {
  const limiter = createRateLimiter({ max: 5, windowMs: 60_000 }, { maxKeys: 5 });
  for (let i = 0; i < 5; i++) assert.equal(limiter.hit(`k${i}`, 0), null);
  for (let i = 5; i < 50; i++) assert.notEqual(limiter.hit(`k${i}`, 0), null, `k${i}`);
  assert.equal(limiter.size(), 5);
});

test("rate-limit: una clave existente sigue contando con el Map lleno", () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 60_000 }, { maxKeys: 3 });
  assert.equal(limiter.hit("a", 0), null);
  limiter.hit("b", 0);
  limiter.hit("c", 0);
  assert.notEqual(limiter.hit("d", 0), null);
  assert.equal(limiter.hit("a", 1), null);
  assert.notEqual(limiter.hit("a", 2), null);
});

test("rate-limit: las entradas vencidas se liberan y el Map vuelve a admitir claves", () => {
  const limiter = createRateLimiter({ max: 5, windowMs: 1000 }, { maxKeys: 3 });
  for (const k of ["a", "b", "c"]) limiter.hit(k, 0);
  assert.equal(limiter.size(), 3);
  assert.equal(limiter.hit("nueva", 1500), null);
  assert.ok(limiter.size() <= 1, `size=${limiter.size()}`);
});

test("rate-limit: hit() no recorre el Map en cada llamada (barrida como mucho una vez por ventana)", () => {
  let iterations = 0;
  class CountingMap extends Map<string, Bucket> {
    [Symbol.iterator]() {
      iterations += 1;
      return super[Symbol.iterator]();
    }
  }
  const limiter = createRateLimiter({ max: 1_000_000, windowMs: 60_000 }, { store: new CountingMap() });
  for (let i = 0; i < 500; i++) limiter.hit(`ip-${i % 50}`, i);
  assert.equal(iterations, 0, "sin cambiar de ventana no se recorre");
  limiter.hit("x", 60_000 + 1);
  limiter.hit("y", 60_000 + 2);
  limiter.hit("z", 60_000 + 3);
  assert.equal(iterations, 1, "una barrida por ventana");
});
