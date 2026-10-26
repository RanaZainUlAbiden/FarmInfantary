// Private metadata only. This snapshot does not authorize the raw SQL pipeline.
// Staff remain denied until an instrumented/reviewed operation map is installed.
export async function loadStaffPermissions(pool,actor) {
 if(actor?.role!=='staff'||![actor.userId,actor.farmId,actor.authVersion].every(v=>Number.isSafeInteger(v)&&v>0))return null;
 const {rows}=await pool.query(`SELECT u.auth_version,p.permission_key,p.can_view,p.can_create,p.can_edit,p.can_delete
  FROM users u JOIN LATERAL auth_farm_metadata(u.farm_id) f ON f.status='active'
  LEFT JOIN user_permissions p ON p.user_id=u.user_id AND p.farm_id=u.farm_id
  LEFT JOIN permission_catalogue c ON c.permission_key=p.permission_key
  WHERE u.user_id=$1 AND u.farm_id=$2 AND u.auth_version=$3 AND u.role='staff' AND u.status='active'
   AND (p.permission_key IS NULL OR c.permission_key IS NOT NULL)
  ORDER BY p.permission_key`,[actor.userId,actor.farmId,actor.authVersion]);
 if(!rows.length)return null;
 return Object.freeze({authVersion:actor.authVersion,grants:Object.freeze(rows.filter(r=>r.permission_key).map(r=>Object.freeze({
  key:r.permission_key,view:r.can_view===1,create:r.can_create===1,edit:r.can_edit===1,delete:r.can_delete===1,
 })))});
}
