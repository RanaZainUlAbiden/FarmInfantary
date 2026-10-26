import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const output=resolve('dist/farminfantary/browser');
const html=readFileSync(resolve(output,'index.html'),'utf8');
const liveHtml=html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,'');
const sheets=liveHtml.match(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)||[];
assert.ok(sheets.length,'A production stylesheet must load without JavaScript handlers.');
for(const link of sheets){assert.ok(!/\son\w+=/i.test(link),'CSP blocks inline stylesheet event handlers.');assert.ok(!/\bmedia=["']print["']/i.test(link),'A screen stylesheet cannot depend on a blocked print-to-screen handler.');const href=link.match(/href=["']([^"']+)/i)?.[1];assert.ok(href&&existsSync(resolve(output,href)),'The generated stylesheet must exist.');const css=readFileSync(resolve(output,href),'utf8');assert.ok(css.includes('.auth-screen')&&css.includes('.auth-card'),'Sign-in layout styles must survive the production build.');}
assert.match(html,/<title>FarmInfantary<\/title>/);
assert.ok(!/favicon\.ico/.test(html));
for(const asset of ['logo.png','favicon.png'])assert.ok(readFileSync(resolve(output,asset)).equals(readFileSync(resolve('public',asset))),'Built '+asset+' must exactly match the supplied asset.');
assert.equal(JSON.parse(readFileSync(resolve(output,'manifest.webmanifest'),'utf8')).name,'FarmInfantary');
console.log('Production shell verified: CSP-compatible screen CSS, sign-in layout and supplied FarmInfantary assets.');
