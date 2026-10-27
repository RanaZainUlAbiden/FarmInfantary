export const sidebarItemKey=(item:any):string=>item.route+(item.queryParams?.add?':add':'');
/** Saved keys only influence presentation: never create links or permissions. */
export function orderedSidebarItems(items:any[],order:unknown):any[]{
 if(!Array.isArray(order))return [...items];
 const remaining=new Map(items.map(item=>[sidebarItemKey(item),item])),result:any[]=[];
 for(const key of order){if(typeof key==='string'&&remaining.has(key)){result.push(remaining.get(key));remaining.delete(key);}}
 return [...result,...remaining.values()];
}
