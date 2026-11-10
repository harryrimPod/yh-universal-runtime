const pad4 = n => (n + 3) & ~3;

function readString(buf, offset) {
  const end = buf.indexOf(0, offset);
  if (end < 0) throw new Error('OSC string missing null terminator');
  return { value: buf.toString('utf8', offset, end), next: offset + pad4(end - offset + 1) };
}

function writeString(value) {
  const body = Buffer.from(`${value}\0`, 'utf8');
  const out = Buffer.alloc(pad4(body.length));
  body.copy(out);
  return out;
}

function parseMessage(buf) {
  const { value: address, next: addressEnd } = readString(buf, 0);
  if (!address.startsWith('/')) throw new Error(`Invalid OSC address: ${address}`);
  const { value: typeString, next: argsStart } = readString(buf, addressEnd);
  if (!typeString.startsWith(',')) throw new Error('OSC type tag string must start with comma');
  let offset = argsStart;
  const args = [];
  for (const tag of typeString.slice(1)) {
    switch (tag) {
      case 'i':
        if (offset + 4 > buf.length) throw new Error('Truncated OSC int32');
        args.push(buf.readInt32BE(offset)); offset += 4; break;
      case 'f':
        if (offset + 4 > buf.length) throw new Error('Truncated OSC float32');
        args.push(buf.readFloatBE(offset)); offset += 4; break;
      case 'd':
        if (offset + 8 > buf.length) throw new Error('Truncated OSC float64');
        args.push(buf.readDoubleBE(offset)); offset += 8; break;
      case 'h':
        if (offset + 8 > buf.length) throw new Error('Truncated OSC int64');
        args.push(buf.readBigInt64BE(offset).toString()); offset += 8; break;
      case 's': {
        const result = readString(buf, offset); args.push(result.value); offset = result.next; break;
      }
      case 'b': {
        if (offset + 4 > buf.length) throw new Error('Truncated OSC blob length');
        const size = buf.readInt32BE(offset); offset += 4;
        if (size < 0 || offset + size > buf.length) throw new Error('Invalid OSC blob length');
        args.push(buf.subarray(offset, offset + size).toString('base64'));
        offset += pad4(size); break;
      }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      case 'I': args.push('Infinity'); break;
      default: throw new Error(`Unsupported OSC type tag: ${tag}`);
    }
  }
  if (offset > buf.length) throw new Error('OSC packet is truncated');
  return [{ address, typeTags: typeString.slice(1), args }];
}

export function decodeOSCPacket(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 4) throw new Error('OSC packet is too short');
  if (buf.subarray(0, 8).toString('ascii') !== '#bundle\0') return parseMessage(buf);
  if (buf.length < 16) throw new Error('OSC bundle is truncated');
  const result = [];
  let offset = 16; // 8-byte #bundle string + 8-byte timetag
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('OSC bundle element size is truncated');
    const size = buf.readInt32BE(offset); offset += 4;
    if (size <= 0 || offset + size > buf.length) throw new Error('Invalid OSC bundle element size');
    result.push(...decodeOSCPacket(buf.subarray(offset, offset + size)));
    offset += size;
  }
  return result;
}

export function encodeOSCMessage(address, args = []) {
  if (typeof address !== 'string' || !address.startsWith('/') || address.includes('\0')) throw new Error('OSC address must start with / and contain no null bytes');
  const tags = [];
  const parts = [writeString(address)];
  for (const value of args) {
    if (typeof value === 'boolean') { tags.push(value ? 'T' : 'F'); continue; }
    if (typeof value === 'string') { tags.push('s'); parts.push(writeString(value)); continue; }
    if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      tags.push('i'); const item = Buffer.alloc(4); item.writeInt32BE(value); parts.push(item); continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      tags.push('f'); const item = Buffer.alloc(4); item.writeFloatBE(value); parts.push(item); continue;
    }
    throw new Error(`Cannot encode OSC argument: ${String(value)}`);
  }
  parts.splice(1, 0, writeString(`,${tags.join('')}`));
  return Buffer.concat(parts);
}
