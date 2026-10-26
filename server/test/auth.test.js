import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authConfig,readSessionToken,sessionCookie,sameOriginRequest} from '../src/auth/config.js';
import {normalizeUsername} from '../src/auth/store.js';
import {hashPassword,verifyPassword,validNewPassword,createPasswordWorkLimit} from '../src/auth/password.js';
const env={NODE_ENV:'development',SESSION_SECRET:'a'.repeat(64),APP_ORIGIN:'http://localhost:4200'};

test('passwords use salted Argon2id and reject wrong, legacy or malformed hashes',async()=>{
 const password='a long verification password 🐓';
 const a=await hashPassword(password),b=await hashPassword(password);
 assert.match(a,/^\$argon2id\$v=19\$/);
 assert.deepEqual(Object.fromEntries(a.split('$')[3].split(',').map(p=>p.split('='))),{m:'65536',t:'3',p:'1'});assert.notEqual(a,b);
 assert.equal(await verifyPassword(a,password),true);assert.equal(await verifyPassword(a,password+'x'),false);
 for(const invalid of ['123abc','$argon2id$broken',null])assert.equal(await verifyPassword(invalid,password),false);
 assert.equal(await verifyPassword(a.replace('m=65536','m=4294967296'),password),false);
 assert.equal(await verifyPassword(a.replace('t=3','t=999999'),password),false);
});
test('new passwords have explicit length bounds and preserve whitespace',async()=>{
 assert.equal(validNewPassword('short'),false);assert.equal(validNewPassword('x'.repeat(129)),false);
 assert.equal(validNewPassword('x'.repeat(15)),true);assert.equal(validNewPassword('🐓'.repeat(128)),true);
 await assert.rejects(hashPassword('short'),/15 to 128/);
 const hash=await hashPassword('  whitespace is part of my password  ');
 assert.equal(await verifyPassword(hash,'whitespace is part of my password'),false);
});
test('native password work is bounded without an unbounded waiting queue',async()=>{
 const work=createPasswordWorkLimit(1);let finish;
 const first=work(()=>new Promise(resolve=>{finish=resolve;}));
 assert.deepEqual(await work(()=>{throw new Error('must not execute');}),{busy:true});
 finish('done');assert.deepEqual(await first,{value:'done'});
 await assert.rejects(work(()=>{throw new Error('fail');}),/fail/);
 assert.deepEqual(await work(()=>42),{value:42});
});
test('origins and secrets fail closed; HTTP is limited to local development',()=>{
 for(const secret of ['CHANGE_ME','short',undefined])assert.throws(()=>authConfig({...env,SESSION_SECRET:secret}),/SESSION_SECRET/);
 for(const origin of ['http://example.com','https://example.com/path','https://u:p@example.com','https://example.com/'])assert.throws(()=>authConfig({...env,APP_ORIGIN:origin}),/APP_ORIGIN/);
 assert.throws(()=>authConfig({...env,NODE_ENV:'production'}),/APP_ORIGIN/);
 const config=authConfig({...env,NODE_ENV:'production',APP_ORIGIN:'https://farm.example'});
 const cookie=sessionCookie(config,'A'.repeat(43));assert.match(cookie,/^__Host-fi_session=/);
 for(const part of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(cookie.includes(part));
 assert.ok(!cookie.includes('Domain='));assert.match(sessionCookie(config,'',true),/Max-Age=0/);
});
test('cookie parsing rejects duplicates, encodings, malformed and non-cookie credentials',()=>{
 const token='A'.repeat(43),name='fi_session';
 assert.equal(readSessionToken({headers:{cookie:`a=1; ${name}=${token}`}},name),token);
 for(const cookie of [`${name}=${token}; ${name}=${token}`,`${name}=%41`,`${name}=bad`,name])assert.equal(readSessionToken({headers:{cookie}},name),null);
 assert.equal(readSessionToken({headers:{authorization:'Bearer '+token},body:{token}},name),null);
});
test('mutations require exact Origin and refuse cross-site Fetch Metadata',()=>{
 const config=authConfig(env);
 assert.equal(sameOriginRequest({headers:{origin:env.APP_ORIGIN}},config,true),true);
 for(const headers of [{},{origin:'https://evil.example'},{origin:env.APP_ORIGIN,'sec-fetch-site':'cross-site'}])assert.equal(sameOriginRequest({headers},config,true),false);
 assert.equal(sameOriginRequest({headers:{}},config,false),true);
});
test('usernames normalize only the documented ASCII login alphabet',()=>{
 assert.equal(normalizeUsername(' Owner_One '),'owner_one');
 for(const value of ['ab','a b','../a','a@b',{},null,'a'.repeat(65)])assert.equal(normalizeUsername(value),null);
});
