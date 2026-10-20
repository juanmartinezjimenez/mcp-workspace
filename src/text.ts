const encoder = new TextEncoder();

/** Size of a string in UTF-8 bytes, the unit every limit uses. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}
