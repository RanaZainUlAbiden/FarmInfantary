export type BusinessBundle='broiler_distribution'|'layer_distribution'|'all';
export type BusinessTab='broiler'|'layer'|'distribution'|'overview';
export const BUSINESS_BUNDLES=[
 {value:'broiler_distribution',label:'Broiler + Distribution'},
 {value:'layer_distribution',label:'Layers + Distribution'},
 {value:'all',label:'All three modules'}
] as const;
/** Legacy saved values remain readable; all new choices use the three bundles. */
export function businessBundle(value:unknown):BusinessBundle{
 if(value==='layer'||value==='layer_distribution')return 'layer_distribution';
 if(value==='all'||value==='distribution')return 'all';
 return 'broiler_distribution';
}
export function businessTabs(value:unknown):BusinessTab[]{
 const bundle=businessBundle(value);
 return bundle==='all'?['broiler','layer','distribution','overview']:bundle==='layer_distribution'?['layer','distribution','overview']:['broiler','distribution','overview'];
}
export function activeBusinessModule(value:unknown,preferred:unknown):BusinessTab{
 const tabs=businessTabs(value);return tabs.includes(preferred as BusinessTab)?preferred as BusinessTab:tabs[0];
}
export const businessBundleLabel=(value:unknown):string=>BUSINESS_BUNDLES.find(b=>b.value===businessBundle(value))!.label;
