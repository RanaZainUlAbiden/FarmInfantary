// Adapt the existing logo for the install manifest without modifying its pixels.
import {readFileSync, writeFileSync} from 'node:fs';
const root = new URL('../../public/', import.meta.url);
const png = readFileSync(new URL('logo.png', root)).toString('base64');
writeFileSync(new URL('app-icon.svg', root), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1039 1024"><image width="1039" height="1024" href="data:image/png;base64,${png}"/></svg>\n`);
