const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=(maxLength=400)=>({type:'string',maxLength});
const strings=(maxItems,maxLength)=>({type:'array',items:text(maxLength),maxItems});
export function cardOutputSchema(packet){
 if(!['canonical-review-packet-v1','canonical-synthesis-packet-v1'].includes(packet.schema))return null;
 const synthesis=packet.schema==='canonical-synthesis-packet-v1',candidates=synthesis?[...(packet.previous?.candidates||[]),...(packet.parts||[]).flatMap(p=>p.candidates)]:[],presentRoles=new Set((packet.units||[]).map(u=>u.role));
 const kinds=synthesis?[...new Set(candidates.map(c=>c.kind))]:Object.keys(packet.allowed_item_kinds||{}).filter(k=>presentRoles.has(packet.allowed_item_kinds[k]));
 const variants=(kinds.length?kinds:['note_statement']).map(kind=>object({kind:{type:'string',enum:[kind]},text:text(400),...(synthesis?{refs:{type:'array',minItems:1,maxItems:4,items:{type:'string',enum:candidates.filter(c=>c.kind===kind).map(c=>c.id).length?candidates.filter(c=>c.kind===kind).map(c=>c.id):['none']}}}:{evidence:{type:'array',minItems:1,maxItems:4,items:object({unit_id:{type:'string',enum:(packet.units||[]).filter(u=>u.role===packet.allowed_item_kinds[kind]).map(u=>u.id).length?packet.units.filter(u=>u.role===packet.allowed_item_kinds[kind]).map(u=>u.id):['none']},role:{type:'string',enum:[packet.allowed_item_kinds[kind]||'note']},quote:{type:'string',minLength:6,maxLength:500,description:'Буквальная уникальная цитата. Сохрани исходные пробелы и знаки.'}})}})}));
 const properties={title:text(200),questions:strings(5,200),keywords:strings(20,60),items:{type:'array',maxItems:kinds.length?8:0,items:variants.length===1?variants[0]:{anyOf:variants}},uncertainties:strings(5,240)};
 if(!synthesis)properties.disposition={type:'string',enum:['card','no-useful-content','needs-manual-review']};return object(properties);
}
