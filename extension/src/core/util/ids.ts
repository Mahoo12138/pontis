// UUIDv7 generation for op_id and other client-side identifiers
// (doc 22 A: operation ids use UUIDv7).

export function uuidv7(): string {
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const tsHex = Date.now().toString(16).padStart(12, '0'); // 48-bit ms epoch
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  const raw = tsHex + randHex; // 32 hex chars
  // Version nibble = first char of group 3, variant = first char of group 4.
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-7${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}
