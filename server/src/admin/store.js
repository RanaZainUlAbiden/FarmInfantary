// Dedicated private metadata operations. Never connected to client SQL.
export class AdminError extends Error {constructor(status,message){super(message);this.status=status;}}
const refuse=(status,message)=>{throw new AdminError(status,message);};
const fields='user_id,username,farm_id,role,status,auth_version';
export function createAdminStore(pool,{onRevokeUser=async()=>{}}={}) {
 const admin=actor=>{if(actor?.role!=='super_admin')refuse(403,'Platform administrator access is required.');};
 async function checkActor(c,actor,lock=false) {
  if(!actor||!['super_admin','farm_admin'].includes(actor.role))refuse(403,'Administrator access is required.');
  const r=await c.query(`SELECT u.user_id FROM users u LEFT JOIN LATERAL auth_farm_metadata(u.farm_id) f ON true
   WHERE u.user_id=$1 AND u.auth_version=$2 AND u.role=$3 AND u.status='active'
    AND (u.role='super_admin' OR (u.farm_id=$4 AND f.status='active')) ${lock?'FOR SHARE OF u':''}`,[actor.userId,actor.authVersion,actor.role,actor.farmId]);
  if(!r.rowCount)refuse(401,'Your account changed. Sign in again.');
 }
 async function transaction(actor,work) {
  const c=await pool.connect(),revoked=new Set();let result;
  try {await c.query('BEGIN');await checkActor(c,actor);result=await work(c,revoked);await checkActor(c,actor,true);await c.query('COMMIT');}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  for(const id of revoked)await onRevokeUser(id);
  return result;
 }
 async function farm(c,id) {
  await c.query("SELECT set_config('app.farm_id',$1,true)",[String(id)]);
  const r=await c.query('SELECT farm_id,farm_name,business_type,status,staff_seat_limit,can_admin_add_staff,admin_version FROM farms WHERE farm_id=$1 FOR UPDATE',[id]);
  if(!r.rowCount)refuse(404,'Farm not found.');return r.rows[0];
 }
 async function target(c,actor,id,version) {
  const info=(await c.query('SELECT farm_id,role FROM users WHERE user_id=$1',[id])).rows[0];
  if(!info||!['farm_admin','staff'].includes(info.role)||
    (actor.role!=='super_admin'&&(info.role!=='staff'||info.farm_id!==actor.farmId)))refuse(404,'User not found.');
  await farm(c,info.farm_id);
  // Recheck the initially authorized role after acquiring the farm/user locks.
  const r=await c.query(`SELECT ${fields} FROM users WHERE user_id=$1 AND farm_id=$2 AND role=$3 FOR UPDATE`,[id,info.farm_id,info.role]);
  if(!r.rowCount)refuse(409,'User changed. Reload and try again.');
  if(r.rows[0].auth_version!==version)refuse(409,'User changed. Reload and try again.');return r.rows[0];
 }
 async function audit(c,actor,farmId,action,targetId,details={}) {
  await c.query('INSERT INTO audit_events(actor_id,farm_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)',[actor.userId,farmId,action,targetId,details]);
 }
 async function revoke(c,ids,revoked) {
  for(const id of ids){await c.query('DELETE FROM auth_sessions WHERE user_id=$1',[id]);revoked.add(id);}
 }
 return {
  async getFarm(actor,id){admin(actor);await checkActor(pool,actor);const f=(await pool.query('SELECT * FROM admin_farm_metadata($1)',[id])).rows[0];if(!f)refuse(404,'Farm not found.');return f;},
  async listFarms(actor,before=null,limit=50) {
   admin(actor);await checkActor(pool,actor);
   // Fresh farms and their first administrator are created atomically. Their
   // private user index supplies IDs; root metadata is read one scoped ID at a time.
   return (await pool.query(`SELECT f.* FROM (SELECT DISTINCT farm_id FROM users WHERE farm_id IS NOT NULL
    AND ($1::bigint IS NULL OR farm_id<$1) ORDER BY farm_id DESC LIMIT $2) ids
    CROSS JOIN LATERAL admin_farm_metadata(ids.farm_id) f ORDER BY f.farm_id DESC`,[before,limit])).rows;
  },
  async listUsers(actor,farmId,before=null,limit=50) {
   await checkActor(pool,actor);if(actor.role!=='super_admin'&&actor.farmId!==farmId)refuse(403,'This farm is not available.');
   return (await pool.query(`SELECT ${fields} FROM users WHERE farm_id=$1 AND role IN ('farm_admin','staff')
    AND ($2::bigint IS NULL OR user_id<$2) AND ($3::text='super_admin' OR role='staff') ORDER BY user_id DESC LIMIT $4`,[farmId,before,actor.role,limit])).rows;
  },
  async ownTeam(actor,before=null,limit=50) {
   if(actor?.role!=='farm_admin')refuse(403,'Farm administrator access is required.');await checkActor(pool,actor);
   const metadata=(await pool.query('SELECT * FROM admin_farm_metadata($1)',[actor.farmId])).rows[0];
   return {farm:metadata,users:await this.listUsers(actor,actor.farmId,before,limit)};
  },
  async catalogue(actor) {await checkActor(pool,actor);return (await pool.query('SELECT permission_key,module,route,label FROM permission_catalogue ORDER BY permission_key')).rows;},
  async permissions(actor,id) {
   await checkActor(pool,actor);
   const u=(await pool.query(`SELECT ${fields} FROM users WHERE user_id=$1 AND role='staff'
    AND ($2::text='super_admin' OR farm_id=$3)`,[id,actor.role,actor.farmId])).rows[0];
   if(!u)refuse(404,'Staff user not found.');
   return {user:u,grants:(await pool.query('SELECT permission_key,can_view,can_create,can_edit,can_delete FROM user_permissions WHERE user_id=$1 AND farm_id=$2 ORDER BY permission_key',[id,u.farm_id])).rows};
  },
  async createFarm(actor,input) {
   admin(actor);return transaction(actor,async c=>{
    const id=(await c.query("SELECT nextval(pg_get_serial_sequence('farms','farm_id')) AS id")).rows[0].id;
    await c.query("SELECT set_config('app.farm_id',$1,true)",[String(id)]);
    await c.query("INSERT INTO farms(farm_id,farm_name,business_type,password_hash) VALUES($1,$2,$3,'retired-server-identity')",[id,input.farmName,input.businessType]);
    const u=(await c.query(`INSERT INTO users(farm_id,username,password_hash,role) VALUES($1,$2,$3,'farm_admin') RETURNING ${fields}`,[id,input.username,input.passwordHash])).rows[0];
    await audit(c,actor,id,'farm.created',id,{ownerId:u.user_id,businessType:input.businessType});return {farmId:id,user:u};
   });
  },
  async updateFarm(actor,id,input) {
   admin(actor);return transaction(actor,async(c,revoked)=>{
    const old=await farm(c,id);if(old.admin_version!==input.expectedVersion)refuse(409,'Farm changed. Reload and try again.');
    const changed=old.farm_name!==input.farmName||old.business_type!==input.businessType||old.status!==input.status||old.staff_seat_limit!==input.seatLimit||old.can_admin_add_staff!==Number(input.allowStaffCreation);
    if(!changed)return {changed:false};
    await c.query('UPDATE farms SET farm_name=$1,business_type=$2,status=$3,staff_seat_limit=$4,can_admin_add_staff=$5 WHERE farm_id=$6',[input.farmName,input.businessType,input.status,input.seatLimit,Number(input.allowStaffCreation),id]);
    if(old.status!==input.status)await revoke(c,(await c.query('SELECT user_id FROM users WHERE farm_id=$1',[id])).rows.map(r=>r.user_id),revoked);
    await audit(c,actor,id,'farm.updated',id,{status:input.status,seatLimit:input.seatLimit,allowStaffCreation:input.allowStaffCreation,businessType:input.businessType});return {changed:true};
   });
  },
  async createStaff(actor,id,input) {
   return transaction(actor,async c=>{
    if(actor.role!=='super_admin'&&actor.farmId!==id)refuse(403,'This farm is not available.');
    const f=await farm(c,id);
    if(f.status!=='active')refuse(409,'Activate the farm before adding staff.');
    if(actor.role!=='super_admin'&&f.can_admin_add_staff!==1)refuse(403,'Staff creation has not been delegated to this farm.');
    const u=(await c.query(`INSERT INTO users(farm_id,username,password_hash,role) VALUES($1,$2,$3,'staff') RETURNING ${fields}`,[id,input.username,input.passwordHash])).rows[0];
    await audit(c,actor,id,'user.created',u.user_id,{role:'staff'});return {user:u};
   });
  },
  async setStatus(actor,id,{expectedVersion,status}) {
   return transaction(actor,async(c,revoked)=>{
    const u=await target(c,actor,id,expectedVersion);if(u.status===status)return {changed:false};
    await c.query('UPDATE users SET status=$1 WHERE user_id=$2',[status,id]);await revoke(c,[id],revoked);
    await audit(c,actor,u.farm_id,'user.status',id,{status});return {changed:true};
   });
  },
  async resetPassword(actor,id,{expectedVersion,passwordHash}) {
   return transaction(actor,async(c,revoked)=>{
    const u=await target(c,actor,id,expectedVersion);await c.query('UPDATE users SET password_hash=$1 WHERE user_id=$2',[passwordHash,id]);
    await revoke(c,[id],revoked);await audit(c,actor,u.farm_id,'user.password',id);return {changed:true};
   });
  },
  async setPermissions(actor,id,{expectedVersion,grants}) {
   return transaction(actor,async(c,revoked)=>{
    const u=await target(c,actor,id,expectedVersion);if(u.role!=='staff')refuse(400,'Only staff users have permission grants.');
    const known=new Set((await c.query('SELECT permission_key FROM permission_catalogue')).rows.map(r=>r.permission_key));
    if(grants.some(g=>!known.has(g.key)))refuse(400,'Unknown permission key.');
    const old=new Map((await c.query('SELECT * FROM user_permissions WHERE user_id=$1',[id])).rows.map(r=>[r.permission_key,r]));
    const next=new Map(grants.map(g=>[g.key,g]));let changed=0;
    for(const key of new Set([...old.keys(),...next.keys()])) {
     const a=old.get(key),b=next.get(key),flags=b?[b.view,b.create,b.edit,b.delete].map(Number):[0,0,0,0];
     if(!flags[0]){if(a){await c.query('DELETE FROM user_permissions WHERE user_id=$1 AND permission_key=$2',[id,key]);changed++;}continue;}
     if(a&&['can_view','can_create','can_edit','can_delete'].every((f,i)=>a[f]===flags[i]))continue;
     await c.query(`INSERT INTO user_permissions(user_id,farm_id,permission_key,can_view,can_create,can_edit,can_delete) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(user_id,permission_key) DO UPDATE SET can_view=excluded.can_view,can_create=excluded.can_create,can_edit=excluded.can_edit,can_delete=excluded.can_delete`,[id,u.farm_id,key,...flags]);changed++;
    }
    if(changed){await revoke(c,[id],revoked);await audit(c,actor,u.farm_id,'user.permissions',id,{changedKeys:changed});}
    return {changed:changed>0};
   });
  },
  async audit(actor,before=null,limit=50) {admin(actor);await checkActor(pool,actor);return (await pool.query('SELECT event_id,actor_id,farm_id,action,target_id,details,created_at FROM audit_events WHERE ($1::bigint IS NULL OR event_id<$1) ORDER BY event_id DESC LIMIT $2',[before,limit])).rows;},
 };
}
