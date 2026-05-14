import { describe, expect, it } from "vitest";
import { extractJsonObject } from "./client.js";

describe("extractJsonObject", () => {
  it("parses bare JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses fenced ```json blocks", () => {
    const raw = "Sure, here:\n```json\n{\"a\":1, \"b\": [2,3]}\n```\nDone.";
    expect(extractJsonObject(raw)).toEqual({ a: 1, b: [2, 3] });
  });

  it("parses fenced ``` (no language) blocks", () => {
    const raw = "```\n{\"a\":true}\n```";
    expect(extractJsonObject(raw)).toEqual({ a: true });
  });

  it("falls back to first/last brace extraction", () => {
    const raw = "Here is the answer: {\"a\":1, \"nested\": {\"b\":2}} cheers";
    expect(extractJsonObject(raw)).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("throws on empty input", () => {
    expect(() => extractJsonObject("")).toThrow();
  });

  it("throws on input without any JSON object", () => {
    expect(() => extractJsonObject("no json here, sorry")).toThrow();
  });
});
