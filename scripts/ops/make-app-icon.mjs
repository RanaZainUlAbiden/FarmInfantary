// Adapt the existing logo for the install manifest without modifying its pixels.
import {readFileSync, writeFileSync} from 'node:fs';
const root = new URL('../../public/', import.meta.url);
const bytes = readFileSync(new URL('favicon.png', root));
const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
writeFileSync(new URL('app-icon.svg', root), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>\n`);
