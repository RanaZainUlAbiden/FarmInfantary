import {spawn} from 'node:child_process';
// Railway terminates public TLS. The business API is loopback-only; only the
// in-container Caddy process is trusted as a proxy. Never trust arbitrary XFF.
const children=[];let stopping=false,exitCode=0;
function stop(code=0){if(stopping)return;stopping=true;exitCode=code;for(const child of children)child.kill('SIGTERM');const timer=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(exitCode);},10000);timer.unref();}
function start(bin,args,env){const child=spawn(bin,args,{env,stdio:'inherit'});children.push(child);child.on('error',()=>stop(1));child.on('exit',code=>{if(!stopping)stop(code||1);if(children.every(c=>c.exitCode!==null||c.signalCode!==null))process.exit(exitCode);});}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
start(process.execPath,['server/src/server.js'],{...process.env,HOST:'127.0.0.1',PORT:'3000',TRUST_PROXY:'127.0.0.1'});
start('caddy',['run','--config','/app/ops/Caddyfile.railway','--adapter','caddyfile'],{PATH:process.env.PATH,HOME:'/home/node',PORT:process.env.PORT||'8080'});
