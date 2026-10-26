// Execute actual frontend service/guard/interceptor source in a minimal DI and
// storage harness. Angular build + real browser checks verify rendering/runtime.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../../../package.json',import.meta.url));
const ts=require('typescript');
export const rx=require('rxjs');
export class MemoryStorage {
  values=new Map();get length(){return this.values.size;}key(i){return [...this.values.keys()][i]??null;}
  getItem(key){return this.values.get(key)??null;}setItem(key,value){this.values.set(key,String(value));}removeItem(key){this.values.delete(key);}
}
export function loadBrowserSource(relative,imports,globals={}) {
  const source=readFileSync(new URL('../../../'+relative,import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
    experimentalDecorators:true,useDefineForClassFields:false}}).outputText;
  const exports={};
  vm.runInNewContext(js,{exports,module:{exports},require:name=>{if(name==='rxjs')return rx;if(name in imports)return imports[name];throw new Error('Unexpected frontend import: '+name);},
    setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto,...globals},{filename:relative});
  return exports;
}
