import { parseEagleArchive, parseEagleXml } from './eagle.js';
import { parseOdbEntries } from './odb.js';
import { readZip } from './zip.js';

function isZip(file) {
  return /\.zip$/i.test(file.name) || /zip/i.test(file.type);
}

function isJson(file) {
  return /\.json$/i.test(file.name) || /json/i.test(file.type);
}

export async function loadBoardFile(file) {
  if (!file) throw new Error('No board file selected.');

  if (isZip(file)) {
    const entries = await readZip(file);
    const names = [...entries.keys()];
    const boardName = names.find((name) => /\.brd$/i.test(name));
    if (boardName) {
      const schematicName = names.find((name) => /\.sch$/i.test(name));
      return { board: parseEagleArchive(entries, boardName, schematicName), name: file.name };
    }
    return { board: parseOdbEntries(entries), name: file.name };
  }

  if (/\.brd$/i.test(file.name)) {
    return { board: parseEagleXml(await file.text(), '', file.name), name: file.name };
  }

  if (isJson(file)) {
    return { board: JSON.parse(await file.text()), name: file.name };
  }

  throw new Error('Select a JSON file, EAGLE .brd file, or ZIP archive.');
}
