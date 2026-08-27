function zipU16(view, offset) {
  return view.getUint16(offset, true);
}

function zipU32(view, offset) {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes) {
  if (!window.DecompressionStream) {
    throw new Error('This browser does not support ZIP deflate decompression. Use a current Chrome or Edge build.');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let endOfDirectory = -1;

  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (zipU32(view, offset) === 0x06054b50) {
      endOfDirectory = offset;
      break;
    }
  }
  if (endOfDirectory < 0) {
    throw new Error('Not a readable ZIP archive (end-of-directory record not found).');
  }

  const count = zipU16(view, endOfDirectory + 10);
  const centralDirectoryOffset = zipU32(view, endOfDirectory + 16);
  const entries = new Map();
  const decoder = new TextDecoder();
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (zipU32(view, cursor) !== 0x02014b50) {
      throw new Error('Unsupported ZIP central-directory entry.');
    }

    const method = zipU16(view, cursor + 10);
    const compressedSize = zipU32(view, cursor + 20);
    const nameLength = zipU16(view, cursor + 28);
    const extraLength = zipU16(view, cursor + 30);
    const commentLength = zipU16(view, cursor + 32);
    const localHeaderOffset = zipU32(view, cursor + 42);
    const name = decoder
      .decode(bytes.slice(cursor + 46, cursor + 46 + nameLength))
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, '');

    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    if (zipU32(view, localHeaderOffset) !== 0x04034b50) continue;

    const localNameLength = zipU16(view, localHeaderOffset + 26);
    const localExtraLength = zipU16(view, localHeaderOffset + 28);
    const start = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.slice(start, start + compressedSize);
    let data;

    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} in ${name}`);

    entries.set(name, decoder.decode(data));
  }

  return entries;
}
