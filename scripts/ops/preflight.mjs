import {buildServer,loadEnv} from '../../server/src/server.js';
import {releaseDigest} from '../../server/src/release.js';
loadEnv();let result;
try{if(process.env.NODE_ENV!=='production')throw new Error('Release preflight requires NODE_ENV=production and a reviewed owner-only deployment configuration.');result=await buildServer({env:process.env});console.log(JSON.stringify({ready:true,profile:'owner-only',releaseSha:releaseDigest(),staffSql:'disabled'}));}
catch(error){console.error(JSON.stringify({ready:false,error:error.code||error.message,releaseSha:releaseDigest()}));process.exitCode=1;}
finally{await result?.app.close();await result?.pool.end();}
