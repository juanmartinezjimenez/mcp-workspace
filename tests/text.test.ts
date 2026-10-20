import { describe, expect, it } from "vitest";
import { truncateUtf8, utf8Bytes } from "../src/text.js";

describe("UTF-8 helpers", () => {
  it("counts bytes, not characters", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("ñ")).toBe(2);
    expect(utf8Bytes("→")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });

  it("never splits a character when truncating", () => {
    expect(truncateUtf8("abcdef", 4)).toBe("abcd");
    expect(truncateUtf8("año", 2)).toBe("a"); // "ñ" needs 2 more bytes
    expect(truncateUtf8("año", 3)).toBe("añ");
    expect(truncateUtf8("a😀b", 4)).toBe("a"); // the emoji needs 4 bytes
    expect(truncateUtf8("a😀b", 5)).toBe("a😀");
    expect(truncateUtf8("short", 100)).toBe("short");
  });
});
