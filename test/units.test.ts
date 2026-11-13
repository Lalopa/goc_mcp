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

// Map que cuenta cuántos elementos se visitan al iterarlo (por for-of, keys, entries o values).
class CountingMap extends Map<string, Bucket> {
  visited = 0;
  private wrap<T>(it: IterableIterator<T>): IterableIterator<T> {
    const self = this;
    return {
      [Symbol.iterator]() { return this; },
      next() { self.visited += 1; return it.next(); },
    } as IterableIterator<T>;
  }
  [Symbol.iterator]() { return this.wrap(super[Symbol.iterator]()) as any; }
  keys() { return this.wrap(super.keys()) as any; }
  entries() { return this.wrap(super.entries()) as any; }
  values() { return this.wrap(super.values()) as any; }
}

test("rate-limit: el Map nunca pasa del tope y con el Map lleno una clave nueva se admite desalojando la más antigua", () => {
  const limiter = createRateLimiter({ max: 5, windowMs: 60_000 }, { maxKeys: 5, onFull: () => {} });
  for (let i = 0; i < 5; i++) assert.equal(limiter.hit(`k${i}`, i), null);
  for (let i = 5; i < 200; i++) {
    assert.equal(limiter.hit(`k${i}`, i), null, `k${i} debe admitirse`);
    assert.ok(limiter.size() <= 5, `size=${limiter.size()}`);
  }
  assert.equal(limiter.size(), 5);
});

test("rate-limit: con el Map lleno se desaloja la primera clave (la que vence antes) y las demás siguen contando", () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 60_000 }, { maxKeys: 3, onFull: () => {} });
  limiter.hit("a", 0);
  limiter.hit("b", 1);
  limiter.hit("b", 2);
  limiter.hit("c", 3);
  assert.equal(limiter.hit("d", 4), null);
  assert.notEqual(limiter.hit("b", 5), null, "b conserva su cuenta (3 > max)");
  assert.equal(limiter.hit("a", 6), null, "a fue desalojada: cubo nuevo");
});

test("rate-limit: una clave nueva no puede dejar sin servicio a las demás (desalojo, no rechazo)", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 }, { maxKeys: 3, onFull: () => {} });
  for (const k of ["a", "b", "c"]) limiter.hit(k, 0);
  assert.equal(limiter.hit("legítima", 1), null);
});

test("rate-limit: las entradas vencidas se liberan y el Map vuelve a admitir claves", () => {
  const limiter = createRateLimiter({ max: 5, windowMs: 1000 }, { maxKeys: 3 });
  for (const k of ["a", "b", "c"]) limiter.hit(k, 0);
  assert.equal(limiter.size(), 3);
  assert.equal(limiter.hit("nueva", 1500), null);
  assert.equal(limiter.size(), 1);
});

test("rate-limit: ningún hit recorre el Map completo, ni con el Map lleno y muchas claves nuevas", () => {
  const store = new CountingMap();
  const limiter = createRateLimiter({ max: 1_000_000, windowMs: 60_000 }, { store, maxKeys: 1000, onFull: () => {} });
  for (let i = 0; i < 1000; i++) limiter.hit(`k${i}`, i);
  store.visited = 0;
  for (let i = 1000; i < 2000; i++) limiter.hit(`k${i}`, i);
  assert.ok(store.visited <= 2 * 1000, `visitados=${store.visited} (debe ser O(1) por hit)`);
  assert.equal(store.size, 1000);
});

test("rate-limit: la barrida de vencidos se detiene en el primer cubo vigente", () => {
  const store = new CountingMap();
  const limiter = createRateLimiter({ max: 10, windowMs: 1000 }, { store, maxKeys: 5000 });
  for (let i = 0; i < 1000; i++) limiter.hit(`k${i}`, 0);
  limiter.hit("vigente", 900);
  store.visited = 0;
  limiter.hit("x", 1000); // vencen las 1000 de t=0; "vigente" (resetAt 1900) detiene la barrida
  assert.equal(store.size, 2);
  assert.ok(store.visited <= 1002, `visitados=${store.visited}`);
  store.visited = 0;
  for (let i = 0; i < 50; i++) limiter.hit("x", 1001 + i);
  assert.ok(store.visited <= 100, `visitados=${store.visited}: no debe recorrer los vigentes`);
});

test("rate-limit: un cubo propio vencido a mitad de ventana deja de contar", () => {
  const store = new Map<string, Bucket>();
  const limiter = createRateLimiter({ max: 2, windowMs: 1000 }, { store });
  assert.equal(limiter.hit("a", 0), null);
  assert.equal(limiter.hit("a", 500), null);
  assert.notEqual(limiter.hit("a", 600), null, "tercer intento dentro de la ventana");
  assert.equal(limiter.hit("a", 1000), null, "ventana nueva: cuenta 1");
  assert.equal(limiter.hit("a", 1600), null, "cuenta 2, no 4");
  assert.equal(store.size, 1);
});

test("rate-limit: el orden de inserción del Map es el orden de resetAt en todos los caminos", () => {
  const store = new Map<string, Bucket>();
  const limiter = createRateLimiter({ max: 2, windowMs: 1000 }, { store, maxKeys: 4, onFull: () => {} });
  const ordered = () => {
    const resets = [...store.values()].map((b) => b.resetAt);
    assert.deepEqual(resets, [...resets].sort((x, y) => x - y), JSON.stringify([...store]));
  };
  limiter.hit("a", 0);
  limiter.hit("b", 100);
  ordered();
  limiter.hit("a", 1000); // a vence y se recrea: debe quedar DESPUÉS de b
  assert.deepEqual([...store.keys()], ["b", "a"]);
  ordered();
  limiter.hit("c", 1050);
  limiter.hit("d", 1060);
  limiter.hit("e", 1070); // Map lleno: desaloja el primero
  ordered();
  for (let t = 1100; t < 5000; t += 137) {
    limiter.hit(`k${t % 7}`, t);
    ordered();
    assert.ok(store.size <= 4);
  }
});

test("rate-limit: Retry-After es el resto de la ventana en segundos, redondeado hacia arriba y nunca menos de 1", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(limiter.hit("ip", 0), null);
  assert.equal(limiter.hit("ip", 1500), 59);
  assert.equal(limiter.hit("ip", 59_999), 1);
  assert.equal(limiter.hit("ip", 30_000), 30);
});

test("rate-limit: el aviso de Map lleno sale como mucho una vez por ventana", () => {
  let avisos = 0;
  const limiter = createRateLimiter({ max: 5, windowMs: 1000 }, { maxKeys: 2, onFull: () => { avisos += 1; } });
  limiter.hit("a", 0);
  limiter.hit("b", 0);
  for (let i = 0; i < 20; i++) limiter.hit(`n${i}`, 10 + i);
  assert.equal(avisos, 1);
  for (let i = 0; i < 5; i++) limiter.hit(`m${i}`, 1500 + i);
  assert.equal(avisos, 2);
});

test("rate-limit: con el reloj hacia atrás, un cubo propio vencido que la barrida no alcanza se reinicia y se reubica al final", () => {
  const store = new Map<string, Bucket>();
  const limiter = createRateLimiter({ max: 1, windowMs: 1000 }, { store, maxKeys: 10 });
  limiter.hit("a", 1000); // resetAt 2000
  limiter.hit("b", 0); // el reloj retrocedió: resetAt 1000, detrás de a
  limiter.hit("c", 1100); // resetAt 2100
  assert.equal(limiter.hit("b", 1500), null, "b venció: cuenta desde cero, no 2");
  assert.deepEqual([...store.keys()], ["a", "c", "b"], "b se borra y se reinserta al final");
  const resets = [...store.values()].map((x) => x.resetAt);
  assert.deepEqual(resets, [...resets].sort((x, y) => x - y));
});
