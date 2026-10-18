// Ollama at another computer's address (security audit S3): requests to it
// leave the machine, so they are treated like a hosted provider's, and the
// first one carrying the user's question is shown before it is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { askBeforeSending, createProvider, isThisComputer, sendsAway, type ProviderSettings } from "../src/index.ts";
import { fakeServer, rng, SEED } from "./fakes.ts";

test("isThisComputer, worked by hand from how the URL parser reads each address", () => {
  const cases: [string, boolean, string][] = [
    ["http://localhost:11434", true, "the default address"],
    ["http://LOCALHOST:11434", true, "host names are case-blind; the parser lowers them"],
    ["http://ollama.localhost:11434", true, "browsers send every *.localhost name to this computer"],
    ["http://127.0.0.1:11434/", true, "the loopback address"],
    ["http://127.255.255.255", true, "the top of 127.0.0.0/8"],
    ["http://127.1:11434", true, "short form: 127 then 1 as the last 24 bits, read as 127.0.0.1"],
    ["http://0x7f.0.0.1", true, "0x7f = 7×16 + 15 = 127"],
    ["http://0177.0.0.1", true, "octal 0177 = 1×64 + 7×8 + 7 = 127"],
    ["http://2130706433", true, "one number: 127×2^24 + 1 = 2,130,706,432 + 1"],
    ["http://[::1]:11434", true, "IPv6 loopback"],
    ["http://[0:0:0:0:0:0:0:1]", true, "IPv6 loopback written out; the parser shortens it to [::1]"],
    ["http://192.168.1.5:11434", false, "a computer on the local network"],
    ["http://128.0.0.1", false, "just past 127.0.0.0/8"],
    ["https://ollama.example.com", false, "a server on the internet"],
    ["http://localhost.evil.com", false, "a name that starts with localhost is someone else's"],
    ["http://127.0.0.1.nip.io", false, "a name, not an address: DNS decides where it goes"],
    ["http://localhost@evil.com", false, "'localhost' here is a user name; the host is evil.com"],
    ["http://evil.com#@localhost", false, "after # is the fragment; the host is evil.com"],
    ["http://evil.com/?localhost", false, "after ? is the query; the host is evil.com"],
    ["http://127.0.0.1x", false, "not an address, so a name, which DNS decides"],
    ["http://[::ffff:127.0.0.1]", false, "an IPv4-mapped address: asking once more is the safe side"],
    ["http://0.0.0.0:11434", false, "0.0.0.0 is not loopback: asking once more is the safe side"],
    ["http://localhost.:11434", false, "a trailing dot: asking once more is the safe side"],
    ["localhost:11434", false, "no http://, so the parser reads 'localhost' as the scheme and there is no host"],
    ["not an address", false, "doesn't read"],
    ["", false, "empty"],
  ];
  for (const [address, here, why] of cases) assert.equal(isThisComputer(address), here, `${address}: ${why}`);
});

/** One IPv4 address written in one of the forms the URL parser accepts: four, three, two or one parts, each decimal, hex or octal. */
function ipv4Text(bytes: number[], r: () => number): string {
  const [a, b, c, d] = bytes;
  const parts = [[a, b, c, d], [a, b, (c << 8) | d], [a, ((b << 16) | (c << 8) | d) >>> 0], [((a << 24) | (b << 16) | (c << 8) | d) >>> 0]][Math.floor(r() * 4)];
  return parts
    .map((n) => {
      const form = Math.floor(r() * 3);
      return form === 0 ? String(n) : form === 1 ? `0x${n.toString(16)}` : `0${n.toString(8)}`;
    })
    .join(".");
}

test("seeded random: every IPv4 form is this computer exactly when its first byte is 127", () => {
  // The model, from RFC 1122 and not from the code: 127.0.0.0/8 is
  // loopback, every other address is another computer. Half the addresses
  // start with 127, so both answers are reached often.
  const r = rng(SEED).next;
  const seen = { here: 0, away: 0 };
  for (let run = 0; run < 2000; run++) {
    const bytes = [r() < 0.5 ? 127 : Math.floor(r() * 256), ...[0, 0, 0].map(() => Math.floor(r() * 256))];
    const text = ipv4Text(bytes, r);
    const address = `http://${text}:${1 + Math.floor(r() * 65535)}/`;
    const here = bytes[0] === 127;
    assert.equal(isThisComputer(address), here, `seed ${SEED}, run ${run}: ${address} is ${bytes.join(".")}`);
    seen[here ? "here" : "away"]++;
  }
  assert.ok(seen.here > 500 && seen.away > 500, `seed ${SEED}: ${JSON.stringify(seen)}`);
});

test("seeded random: a host name is this computer exactly when it is localhost or ends in .localhost", () => {
  const r = rng(SEED + 1).next;
  const label = () => ["localhost", "ollama", "local", "host", "evil", "lan", "x"][Math.floor(r() * 7)];
  const seen = { here: 0, away: 0 };
  for (let run = 0; run < 2000; run++) {
    const labels = Array.from({ length: 1 + Math.floor(r() * 3) }, label);
    const name = labels.map((l) => (r() < 0.2 ? l.toUpperCase() : l)).join(".");
    // The model, from the URL standard and RFC 6761: the parser lowers the name, and localhost
    // and every name under it are this computer; nothing else is.
    const last = labels[labels.length - 1];
    const here = last === "localhost";
    assert.equal(isThisComputer(`http://${name}:11434`), here, `seed ${SEED + 1}, run ${run}: ${name}`);
    seen[here ? "here" : "away"]++;
  }
  assert.ok(seen.here > 200 && seen.away > 200, `seed ${SEED + 1}: ${JSON.stringify(seen)}`);
});

test("sendsAway: Ollama by its address, a hosted API always, the in-browser kinds never", () => {
  const cases: [ProviderSettings, boolean][] = [
    [{ kind: "ollama" }, false], // no address: the default, localhost
    [{ kind: "ollama", endpoint: "  " }, false], // blank is the default too
    [{ kind: "ollama", endpoint: "http://127.0.0.1:11434" }, false],
    [{ kind: "ollama", endpoint: "http://192.168.1.50:11434" }, true],
    [{ kind: "ollama", endpoint: " https://gpu.example.com " }, true],
    [{ kind: "api-key", vendor: "anthropic" }, true],
    [{ kind: "api-key", vendor: "other", endpoint: "http://localhost:8080/v1" }, true], // a key is still sent, so it is still asked
    [{ kind: "in-browser" }, false],
    [{ kind: "browser-built-in" }, false],
  ];
  for (const [s, away] of cases) assert.equal(sendsAway(s), away, JSON.stringify(s));
});

test("askBeforeSending: another computer's Ollama asks before a question, not before listing its models", () => {
  const remote: ProviderSettings = { kind: "ollama", endpoint: "http://192.168.1.50:11434" };
  assert.equal(askBeforeSending(remote, { body: '{"model":"m"}' }), true);
  assert.equal(askBeforeSending(remote, {}), false, "GET /api/tags carries nothing of the user's");
  assert.equal(askBeforeSending({ kind: "ollama" }, { body: '{"model":"m"}' }), false, "this computer: nothing leaves it");
  assert.equal(askBeforeSending({ kind: "api-key", vendor: "openai" }, {}), true, "listing a hosted API's models sends the key");
  assert.equal(askBeforeSending({ kind: "api-key", vendor: "openai" }, { body: "{}" }), true);
  assert.equal(askBeforeSending({ kind: "in-browser" }, { body: "{}" }), false);
});

test("what another computer's Ollama is sent: its check sends no body, its question sends the part", async () => {
  // So the panel's first-send box (askBeforeSending) catches exactly the
  // request that carries the user's words, and the check never waits on it.
  const { fetch, calls } = fakeServer((c) => (c.url.endsWith("/api/tags") ? { json: { models: [{ name: "qwen2.5:1.5b" }] } } : { json: { message: { content: "ok" } } }));
  const s: ProviderSettings = { kind: "ollama", endpoint: "http://192.168.1.50:11434", model: "qwen2.5:1.5b" };
  const p = createProvider(s, { fetch });
  await p.check();
  await p.complete({ system: "S", messages: [{ role: "user", content: "make it 40 wide" }] });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, askBeforeSending(s, { body: c.body == null ? undefined : JSON.stringify(c.body) })]),
    [
      ["GET", "http://192.168.1.50:11434/api/tags", false],
      ["POST", "http://192.168.1.50:11434/api/chat", true],
    ],
  );
});

test("each rule can fail: a planted mistake in each is caught by the cases above", () => {
  // The mistakes the rules guard against, written out, each checked
  // against one case where it gives the wrong answer.
  const plants: [string, (a: string) => boolean, string, boolean][] = [
    ["a substring check", (a) => a.includes("localhost") || a.includes("127."), "http://localhost.evil.com", false],
    ["a prefix check on the name", (a) => /^https?:\/\/(localhost|127\.)/.test(a), "http://127.0.0.1.nip.io", false],
    ["reading the text before the parser", (a) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(a), "http://127.1:11434", true],
    ["only 127.0.0.1", (a) => new URL(a).hostname === "127.0.0.1" || new URL(a).hostname === "localhost", "http://127.0.0.2", true],
  ];
  for (const [what, wrong, address, right] of plants) {
    assert.equal(isThisComputer(address), right, `${what}: the real rule`);
    assert.notEqual(wrong(address), right, `${what}: the plant answers ${address} wrongly`);
  }
});
