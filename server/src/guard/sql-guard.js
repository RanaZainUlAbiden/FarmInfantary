// SECURITY CRITICAL. Real PostgreSQL 16 AST via libpg-query. Unknown syntax,
// fields, functions and relations fail closed. Never execute the original SQL
// after approval: only the opaque, deparsed prepared capability returned here.
import { parse, deparse } from 'pgsql-parser';
import { translate } from '../db/dialect.js';
import { prepare } from '../db/placeholders.js';
import { sealPrepared } from '../db/prepared.js';
import { TENANT_TABLES, EXCLUDED_TABLES, FARM_READ_COLUMNS, sqlIdentifier } from '../../../db/tenant-tables.mjs';

const allowedTables = new Set(TENANT_TABLES);
const functions = new Set(['count','sum','avg','min','max','lower','upper','btrim','ltrim','rtrim',
  'length','substr','substring','left','right','replace','regexp_replace','string_agg','to_char','trunc','round','abs']);
const types = new Set(['int2','int4','int8','float4','float8','numeric','text','varchar','bool','date','timestamp','timestamptz','interval']);
const forbiddenColumns = new Set(['password_hash','token_hash','activation_code','tableoid','ctid','xmin','xmax','cmin','cmax']);
const operators = new Set(['=','<>','<','<=','>','>=','+','-','*','/','%','||','~~','!~~','~~*','!~~*','BETWEEN','NOT BETWEEN']);
const exprFields = {
  A_Const:['ival','fval','sval','boolval','isnull'], String:['sval'], A_Star:[], ParamRef:['number'],
  ColumnRef:['fields'], ResTarget:['name','val'], List:['items'],
  BoolExpr:['boolop','args'], A_Expr:['kind','name','lexpr','rexpr'], CoalesceExpr:['args'],
  MinMaxExpr:['op','args'], NullTest:['arg','nulltesttype','argisrow'], BooleanTest:['arg','booltesttype'],
  CaseExpr:['arg','args','defresult'], CaseWhen:['expr','result'],
  FuncCall:['funcname','args','agg_star','agg_distinct','agg_order','agg_filter','funcformat'],
  TypeCast:['arg','typeName'], CollateClause:['arg','collname'], SQLValueFunction:['op','typmod'],
  SortBy:['node','sortby_dir','sortby_nulls'], SubLink:['subLinkType','testexpr','operName','subselect'],
};
const deny = () => { throw new Error('SQL access is not allowed.'); };
function fields(value, allowed) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>k!=='location'&&!allowed.includes(k))) deny();
}
function identifier(name) {
  if (typeof name!=='string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(name) || name.startsWith('__fi_')) deny();
  return name;
}
const str = name => ({String:{sval:name}});
const col = (alias,name) => ({ColumnRef:{fields:[str(alias),str(name)]}});
const param = number => ({ParamRef:{number}});
const and = (a,b) => !a?b:!b?a:{BoolExpr:{boolop:'AND_EXPR',args:[a,b]}};
function tenantPredicate(binding, number) {
  const own={A_Expr:{kind:'AEXPR_OP',name:[str('=')],lexpr:col(binding.alias,'farm_id'),rexpr:param(number)}};
  return binding.nullable?{BoolExpr:{boolop:'OR_EXPR',args:[own,{NullTest:{arg:col(binding.alias,'farm_id'),nulltesttype:'IS_NULL'}}]}}:own;
}

export async function loadGuardCatalog(pool, { schema='public' }={}) {
  sqlIdentifier(schema);
  const {rows}=await pool.query(`SELECT c.relname,a.attname,a.attidentity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`,[schema,TENANT_TABLES]);
  const catalog=new Map();
  for(const r of rows) {
    if(!catalog.has(r.relname))catalog.set(r.relname,{columns:new Set(),identity:null});
    const table=catalog.get(r.relname);table.columns.add(r.attname);if(r.attidentity)table.identity=r.attname;
  }
  if(catalog.size!==TENANT_TABLES.length || [...catalog.values()].some(t=>!t.columns.has('farm_id'))) throw new Error('Guard catalog requires tenant migration 004.');
  return catalog;
}

export function createSqlGuard({catalog,schema='public',maxRows=50_000,maxSqlBytes=65_536,maxNodes=12_000,canDelete=async()=>false}={}) {
  sqlIdentifier(schema);
  if(!(catalog instanceof Map))throw new Error('A trusted guard catalog is required.');
  for(const value of [maxRows,maxSqlBytes,maxNodes])if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid SQL guard limit.');
  return async ({actor,method,sql,params=[]})=>{
    try {
      // Staff remain deny-by-default until the derived permission mapping exists.
      if(actor?.role!=='farm_admin' || !/^[1-9][0-9]{0,15}$/.test(String(actor.farmId)) || !Number.isSafeInteger(Number(actor.farmId)))deny();
      if(!['get','run','batch'].includes(method)||typeof sql!=='string'||Buffer.byteLength(sql)>maxSqlBytes||!Array.isArray(params)||params.length>2000)deny();
      for(const value of params) {
        if(value===null||typeof value==='boolean'||typeof value==='string')continue;
        if(typeof value==='number'&&Number.isFinite(value))continue;
        if(method==='batch'&&value&&Object.keys(value).length===1&&Number.isSafeInteger(value.$lastId))continue;
        deny();
      }
      const translated=translate(sql);if(translated.unhandled.length)deny();
      const numbered=prepare(translated.text,params);
      const ast=await parse(numbered.text);
      if(ast.stmts?.length!==1)deny();
      const root=ast.stmts[0].stmt;
      const command=Object.keys(root)[0];
      if(method==='get'?command!=='SelectStmt':!['InsertStmt','UpdateStmt','DeleteStmt'].includes(command))deny();
      const farmNumber=params.length+1, values=[...params,Number(actor.farmId)];
      let nodes=0,idColumn=null;
      const tick=()=>{if(++nodes>maxNodes)deny();};
      function alias(value) {
        if(!value)return null;
        fields(value,['aliasname','colnames']);if(value.colnames?.length)deny();return identifier(value.aliasname);
      }
      function relation(value,ctx,bindings,nullable=false,write=false) {
        tick();fields(value,['relname','inh','relpersistence','alias']);
        const name=identifier(value.relname),as=alias(value.alias)||name;
        if(bindings.some(b=>b.alias===as))deny();
        if(ctx.ctes.has(name)&&!write) {bindings.push({alias:as,cte:true});return null;}
        if(!allowedTables.has(name)||!catalog.has(name)||(write&&name==='farms'))deny();
        value.schemaname=schema;bindings.push({alias:as,table:name,nullable});return catalog.get(name);
      }
      function from(node,ctx,bindings,nullable=false) {
        tick();if(!node||Object.keys(node).length!==1)deny();
        if(node.RangeVar)return relation(node.RangeVar,ctx,bindings,nullable);
        if(node.RangeSubselect) {
          const r=node.RangeSubselect;fields(r,['alias','subquery']);const as=alias(r.alias);if(as&&bindings.some(b=>b.alias===as))deny();
          statement(r.subquery,ctx,true);if(as)bindings.push({alias:as,cte:true});return;
        }
        if(node.JoinExpr) {
          const j=node.JoinExpr;fields(j,['jointype','larg','rarg','quals','usingClause']);
          if(!['JOIN_INNER','JOIN_LEFT','JOIN_RIGHT','JOIN_FULL'].includes(j.jointype))deny();
          from(j.larg,ctx,bindings,nullable||['JOIN_RIGHT','JOIN_FULL'].includes(j.jointype));
          from(j.rarg,ctx,bindings,nullable||['JOIN_LEFT','JOIN_FULL'].includes(j.jointype));
          if(j.quals)expression(j.quals,{...ctx,bindings:[...ctx.bindings,...bindings]});
          for(const c of j.usingClause||[])identifier(c.String?.sval);return;
        }
        deny();
      }
      function expression(node,ctx) {
        if(node==null)return;
        tick();if(!node||typeof node!=='object'||Array.isArray(node)||Object.keys(node).length!==1)deny();
        const [kind,value]=Object.entries(node)[0];
        if(kind==='SelectStmt'){statement(node,ctx,true);return;}
        if(!exprFields[kind])deny();fields(value,exprFields[kind]);
        switch(kind) {
          case 'String': identifier(value.sval);break;
          case 'A_Const': break;
          case 'A_Star': break;
          case 'ParamRef': if(!Number.isSafeInteger(value.number)||value.number<1||value.number>params.length)deny();break;
          case 'ColumnRef': {
            if(!value.fields?.length||value.fields.length>2)deny();
            const names=value.fields.map(f=>f.A_Star?'*':identifier(f.String?.sval));
            if(forbiddenColumns.has(names.at(-1)))deny();
            const farms=ctx.bindings.filter(b=>b.table==='farms').map(b=>b.alias);
            if((names.length===1&&farms.length&&(names[0]==='*'||farms.includes(names[0]))) ||
              (names.length===2&&farms.includes(names[0])&&!FARM_READ_COLUMNS.includes(names[1])))deny();
            break;
          }
          case 'ResTarget': if(value.name)identifier(value.name);expression(value.val,ctx);break;
          case 'List': for(const n of value.items||[])expression(n,ctx);break;
          case 'BoolExpr': if(!['AND_EXPR','OR_EXPR','NOT_EXPR'].includes(value.boolop))deny();for(const n of value.args||[])expression(n,ctx);break;
          case 'A_Expr': {
            if(!['AEXPR_OP','AEXPR_IN','AEXPR_LIKE','AEXPR_ILIKE','AEXPR_BETWEEN','AEXPR_NOT_BETWEEN','AEXPR_NULLIF','AEXPR_DISTINCT','AEXPR_NOT_DISTINCT'].includes(value.kind))deny();
            if(value.name?.length!==1||!operators.has(value.name[0].String?.sval))deny();
            expression(value.lexpr,ctx);expression(value.rexpr,ctx);break;
          }
          case 'CoalesceExpr': for(const n of value.args||[])expression(n,ctx);break;
          case 'MinMaxExpr': if(!['IS_GREATEST','IS_LEAST'].includes(value.op))deny();for(const n of value.args||[])expression(n,ctx);break;
          case 'NullTest': if(!['IS_NULL','IS_NOT_NULL'].includes(value.nulltesttype)||value.argisrow)deny();expression(value.arg,ctx);break;
          case 'BooleanTest': if(!['IS_TRUE','IS_NOT_TRUE','IS_FALSE','IS_NOT_FALSE','IS_UNKNOWN','IS_NOT_UNKNOWN'].includes(value.booltesttype))deny();expression(value.arg,ctx);break;
          case 'CaseExpr': expression(value.arg,ctx);for(const n of value.args||[])expression(n,ctx);expression(value.defresult,ctx);break;
          case 'CaseWhen': expression(value.expr,ctx);expression(value.result,ctx);break;
          case 'FuncCall': {
            const names=value.funcname?.map(n=>n.String?.sval),name=names?.at(-1);
            if(!names?.length||names.length>2||!functions.has(name)||
              (names.length===2&&(names[0]!=='pg_catalog'||value.funcformat!=='COERCE_SQL_SYNTAX')))deny();
            if(value.agg_star&&name!=='count')deny();
            value.funcname=[str('pg_catalog'),str(name)];
            for(const n of value.args||[])expression(n,ctx);for(const n of value.agg_order||[])expression(n,ctx);expression(value.agg_filter,ctx);break;
          }
          case 'TypeCast': {
            const t=value.typeName;fields(t,['names','typemod']);const names=t.names?.map(n=>n.String?.sval),name=names?.at(-1);
            if(!names?.length||names.length>2||(names.length===2&&names[0]!=='pg_catalog')||!types.has(name))deny();
            t.names=[str('pg_catalog'),str(name)];expression(value.arg,ctx);break;
          }
          case 'CollateClause': {
            const names=value.collname?.map(n=>n.String?.sval);if(names?.length!==1||names[0]!=='nocase')deny();
            value.collname=[str('public'),str('nocase')];expression(value.arg,ctx);break;
          }
          case 'SQLValueFunction': if(!['SVFOP_CURRENT_DATE','SVFOP_CURRENT_TIMESTAMP','SVFOP_LOCALTIMESTAMP'].includes(value.op))deny();break;
          case 'SortBy': if(!['SORTBY_DEFAULT','SORTBY_ASC','SORTBY_DESC'].includes(value.sortby_dir)||!['SORTBY_NULLS_DEFAULT','SORTBY_NULLS_FIRST','SORTBY_NULLS_LAST'].includes(value.sortby_nulls))deny();expression(value.node,ctx);break;
          case 'SubLink':
            if(!['EXISTS_SUBLINK','ALL_SUBLINK','ANY_SUBLINK','EXPR_SUBLINK'].includes(value.subLinkType)||value.operName)deny();
            expression(value.testexpr,ctx);statement(value.subselect,ctx,true);break;
          default: deny();
        }
      }
      function withClause(value,ctx) {
        const ctes=new Set(ctx.ctes),next={...ctx,ctes};if(!value)return next;
        fields(value,['ctes','recursive']);if(value.recursive)deny();
        for(const entry of value.ctes||[]) {
          const c=entry.CommonTableExpr;fields(c,['ctename','aliascolnames','ctematerialized','ctequery']);
          const name=identifier(c.ctename);if(allowedTables.has(name)||ctes.has(name)||EXCLUDED_TABLES.includes(name))deny();
          if(!['CTEMaterializeDefault','CTEMaterializeAlways','CTEMaterializeNever'].includes(c.ctematerialized))deny();
          for(const n of c.aliascolnames||[])identifier(n.String?.sval);
          statement(c.ctequery,next,true);ctes.add(name);
        }return next;
      }
      function updateColumns(list,table,ctx) {
        if(!list?.length)deny();
        for(const entry of list) {
          const v=entry.ResTarget;if(!v||!table.columns.has(v.name)||v.name==='farm_id'||v.name===table.identity)deny();expression(entry,ctx);
        }
      }
      function stampInsert(select,index,count) {
        const s=select?.SelectStmt;if(!s)deny();
        if(s.larg||s.rarg){stampInsert({SelectStmt:s.larg},index,count);stampInsert({SelectStmt:s.rarg},index,count);return;}
        if(s.valuesLists) {
          for(const row of s.valuesLists) {if(row.List?.items?.length!==count)deny();if(index<0)row.List.items.push(param(farmNumber));else row.List.items[index]=param(farmNumber);}
        } else {
          if(s.targetList?.length!==count||s.targetList.some(t=>t.ResTarget?.val?.ColumnRef?.fields?.some(f=>f.A_Star)))deny();
          if(index<0)s.targetList.push({ResTarget:{val:param(farmNumber)}});else s.targetList[index]={ResTarget:{val:param(farmNumber)}};
        }
      }
      function statement(node,outer,readOnly=false) {
        tick();if(!node||Object.keys(node).length!==1)deny();
        const [kind,s]=Object.entries(node)[0];if(readOnly&&kind!=='SelectStmt')deny();
        const ctx=withClause(s.withClause,outer),bindings=[];
        if(kind==='SelectStmt') {
          fields(s,['targetList','fromClause','whereClause','groupClause','havingClause','sortClause','distinctClause','limitCount','limitOffset','limitOption','op','all','larg','rarg','valuesLists','withClause']);
          if(!['SETOP_NONE','SETOP_UNION','SETOP_INTERSECT','SETOP_EXCEPT'].includes(s.op)||!['LIMIT_OPTION_DEFAULT','LIMIT_OPTION_COUNT'].includes(s.limitOption))deny();
          for(const n of s.fromClause||[])from(n,ctx,bindings);
          const local={...ctx,bindings:[...ctx.bindings,...bindings]};
          for(const key of ['targetList','groupClause','sortClause','distinctClause','valuesLists'])for(const n of s[key]||[]) {
            if(key==='distinctClause'&&n&&Object.keys(n).length===0)continue;
            if(n)expression(n,local);
          }
          for(const key of ['whereClause','havingClause','limitCount','limitOffset'])expression(s[key],local);
          if(s.larg)statement({SelectStmt:s.larg},ctx,true);if(s.rarg)statement({SelectStmt:s.rarg},ctx,true);
          for(const binding of bindings)if(!binding.cte)s.whereClause=and(s.whereClause,tenantPredicate(binding,farmNumber));
        } else if(kind==='InsertStmt') {
          fields(s,['relation','cols','selectStmt','onConflictClause','override','withClause']);
          if(s.override!=='OVERRIDING_NOT_SET'||!s.cols?.length)deny();
          const table=relation(s.relation,ctx,bindings,false,true),local={...ctx,bindings:[...ctx.bindings,...bindings]};
          const names=s.cols.map(c=>{fields(c.ResTarget,['name']);const name=identifier(c.ResTarget.name);if(!table.columns.has(name)||name===table.identity)deny();return name;});
          if(new Set(names).size!==names.length)deny();
          statement(s.selectStmt,ctx,true);
          stampInsert(s.selectStmt,names.indexOf('farm_id'),names.length);
          if(!names.includes('farm_id'))s.cols.push({ResTarget:{name:'farm_id'}});
          const conflict=s.onConflictClause;
          if(conflict) {
            fields(conflict,['action','infer','targetList','whereClause']);if(!['ONCONFLICT_NOTHING','ONCONFLICT_UPDATE'].includes(conflict.action))deny();
            if(conflict.infer) {
              fields(conflict.infer,['indexElems','whereClause']);
              for(const entry of conflict.infer.indexElems||[]) {fields(entry.IndexElem,['name','ordering','nulls_ordering']);if(!table.columns.has(entry.IndexElem.name))deny();}
              expression(conflict.infer.whereClause,local);
            }
            if(conflict.action==='ONCONFLICT_UPDATE') {
              updateColumns(conflict.targetList,table,local);expression(conflict.whereClause,local);
              conflict.whereClause=and(conflict.whereClause,tenantPredicate(bindings[0],farmNumber));
            }
          }
          if(table.identity){idColumn=table.identity;s.returningList=[{ResTarget:{val:{ColumnRef:{fields:[str(table.identity)]}}}}];}
        } else if(kind==='UpdateStmt'||kind==='DeleteStmt') {
          fields(s,kind==='UpdateStmt'?['relation','targetList','whereClause','fromClause','withClause']:['relation','whereClause','usingClause','withClause']);
          const table=relation(s.relation,ctx,bindings,false,true);
          for(const n of s.fromClause||s.usingClause||[])from(n,ctx,bindings);
          const local={...ctx,bindings:[...ctx.bindings,...bindings]};
          if(kind==='UpdateStmt')updateColumns(s.targetList,table,local);
          expression(s.whereClause,local);
          for(const binding of bindings)if(!binding.cte)s.whereClause=and(s.whereClause,tenantPredicate(binding,farmNumber));
        } else deny();
      }
      statement(root,{ctes:new Set(),bindings:[]});
      const changedColumns=root.UpdateStmt?.targetList||root.InsertStmt?.onConflictClause?.targetList||[];
      if((command==='DeleteStmt'||changedColumns.some(t=>['is_deleted','deleted_at'].includes(t.ResTarget?.name)))&&!await canDelete(actor))deny();
      if(command==='SelectStmt') {
        const s=root.SelectStmt,cap={A_Const:{ival:{ival:maxRows+1}}};
        s.limitCount=s.limitCount?{MinMaxExpr:{op:'IS_LEAST',args:[s.limitCount,cap]}}:cap;s.limitOption='LIMIT_OPTION_COUNT';
      }
      // Rebind only surviving AST params. Supplied farm expressions are discarded
      // in favor of the server value, so their now-unused slots must not reach PG.
      const remap=new Map(),bound=[];
      function rebind(value) {
        if(!value||typeof value!=='object')return;
        if(value.ParamRef){const old=value.ParamRef.number;if(!remap.has(old)){remap.set(old,bound.length+1);bound.push(values[old-1]);}value.ParamRef.number=remap.get(old);return;}
        for(const child of Object.values(value))if(Array.isArray(child))child.forEach(rebind);else rebind(child);
      }
      rebind(ast);
      const text=await deparse(ast);
      return {query:sealPrepared({text,parameterCount:bound.length,idColumn,rowLimit:command==='SelectStmt'?maxRows:null}),params:bound};
    } catch { return false; }
  };
}
