import {readFileSync,readdirSync} from 'node:fs';
import {createBackup} from './backup.mjs';
try {
 // Refuse a successful-looking archive in a container's ephemeral filesystem.
 const mounted=process.platform==='linux'&&readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>line.split(' ')[4]==='/backups');
 if(!mounted)throw new Error('Persistent /backups volume is required; backup refused.');
 const archiveCount=()=>readdirSync('/backups').filter(name=>/^farminfantary-\d+-[a-f0-9]{16}\.fibak$/.test(name)).length;
 const previousArchives=archiveCount();
 const result=await createBackup({connectionString:process.env.BACKUP_DATABASE_URL,outputDir:'/backups',encryptionKey:process.env.BACKUP_ENCRYPTION_KEY,retentionCount:Number(process.env.BACKUP_RETAIN||7)});
 console.log(JSON.stringify({...result,persistentMountVerified:true,previousArchives,archivesAfter:archiveCount()}));
}catch(error){console.error('Backup failed: '+error.message);process.exitCode=1;}
