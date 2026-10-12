import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

const CANARY = `CANARYtest${"ab".repeat(12)}`;
const MASK = REDACTED_EVENT_VALUE;
const encodings = [
  { name: "plain", encode: (text: string) => text },
  {
    name: "JSON-escaped",
    encode: (text: string) => JSON.stringify({ item: { aggregated_output: text } }),
  },
];

describe.each(encodings)("text credentials in $name output", ({ encode }) => {
  const cases = [
    {
      name: "secret header line",
      input: `CF-Access-Client-Secret: ${CANARY}`,
      expected: `CF-Access-Client-Secret: ${MASK}`,
    },
    {
      name: "header line inside a nested event",
      input: JSON.stringify({ item: { aggregated_output: `CF-Access-Client-Secret: ${CANARY}\nDone` } }),
      expected: JSON.stringify({ item: { aggregated_output: `CF-Access-Client-Secret: ${MASK}\nDone` } }),
    },
    ...["CF-Access-Client-Id", "X-API-Key", "Api-Key", "X-Auth-Token", "Cookie", "Set-Cookie", "Proxy-Authorization"].map((name) => ({
      name: `${name} header`,
      input: `${name}: ${CANARY}`,
      expected: `${name}: ${MASK}`,
    })),
    ...["key", "token", "secret", "auth", "pass", "password", "sig", "signature", "credential", "code"].map((name) => ({
      name: `${name} URL query parameter`,
      input: `https://example.invalid/path?page=2&${name}=${CANARY}`,
      expected: `https://example.invalid/path?page=2&${name}=${MASK}`,
    })),
    {
      name: "URL userinfo password",
      input: `https://user:${CANARY}@example.invalid/path`,
      expected: `https://user:${MASK}@example.invalid/path`,
    },
    {
      name: "URL userinfo password with an empty username",
      input: `redis://:${CANARY}@example.invalid:6379/0`,
      expected: `redis://:${MASK}@example.invalid:6379/0`,
    },
    {
      name: "existing provider query parameter",
      input: `https://example.invalid/path?exaApiKey=${CANARY}`,
      expected: `https://example.invalid/path?exaApiKey=${MASK}`,
    },
    {
      name: "existing environment assignment",
      input: `SERVICE_TOKEN=${CANARY}`,
      expected: `SERVICE_TOKEN=${MASK}`,
    },
    {
      name: "existing quoted configuration assignment",
      input: `api_key = "${CANARY}"`,
      expected: `api_key = "${MASK}"`,
    },
  ];

  it.each(cases)("redacts $name", ({ input, expected }) => {
    const result = redactSensitiveText(encode(input));
    expect(result).toBe(encode(expected));
    expect(result).not.toContain("CANARYtest");
    expect(redactSensitiveText(result)).toBe(result);
  });

  it.each(["Bearer", "Basic"])("keeps existing %s authorization redaction", (scheme) => {
    const result = redactSensitiveText(encode(`Authorization: ${scheme} ${CANARY}`));
    expect(result).toContain(MASK);
    expect(result).not.toContain("CANARYtest");
  });

  it.each(["\n", "\r\n", "\r"])("preserves the line after a header ending in %j", (end) => {
    const input = `CF-Access-Client-Id = ${CANARY}${end}Done`;
    expect(redactSensitiveText(encode(input))).toBe(encode(`CF-Access-Client-Id = ${MASK}${end}Done`));
  });

  it.each(["http", "https", "ws", "wss"])("redacts short query values in %s URLs without a dotted host", (scheme) => {
    expect(redactSensitiveText(encode(`${scheme}://server/?sig=x&code=y`)))
      .toBe(encode(`${scheme}://server/?sig=${MASK}&code=${MASK}`));
  });

  it("redacts passwords for other URL schemes", () => {
    expect(redactSensitiveText(encode(`postgres://user:${CANARY}@server/database`)))
      .toBe(encode(`postgres://user:${MASK}@server/database`));
  });

  it("preserves quotes after unquoted header values", () => {
    expect(redactSensitiveText(encode(`curl -H 'Cookie: ${CANARY}'`)))
      .toBe(encode(`curl -H 'Cookie: ${MASK}'`));
  });

  it("preserves query neighbors and fragments around newly supported names", () => {
    const input = `https://example.invalid/?key=${CANARY}&page=2&sig=${CANARY}#section`;
    expect(redactSensitiveText(encode(input)))
      .toBe(encode(`https://example.invalid/?key=${MASK}&page=2&sig=${MASK}#section`));
  });

  it.each([
    "https://example.invalid/?page=2&label=long-public-value#section",
    "https://user@example.invalid/path",
    "https://example.invalid/path/key=value",
    "https://example.invalid/path&key=value",
    "https://example.invalid/#section?key=value",
    "note?key=value",
    "ftp://example.invalid/?key=value",
    "Content-Type: application/json\nDone",
    "Monkey: public-value",
  ])("preserves unrelated text %s", (input) => {
    expect(redactSensitiveText(encode(input))).toBe(encode(input));
  });
});
