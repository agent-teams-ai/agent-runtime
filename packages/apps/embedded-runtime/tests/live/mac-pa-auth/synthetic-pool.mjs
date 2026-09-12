// Fake SQL infrastructure only: no PostgreSQL server, durability or isolation claim.
// Real PA repositories execute their statements and validate their own records.
import {materializationPostgresSchemaDigest} from '@agent-teams/provider-access/dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.js';
import {routeSelectionSchemaDigest} from '@agent-teams/provider-access/dist/features/contained-turn-access/adapters/outbound/postgres/route-selection-schema.js';
import {dispatchOperationSchemaDigest} from '@agent-teams/provider-access/dist/features/contained-turn-access/adapters/outbound/postgres/dispatch-operation-schema.js';
const row=x=>({rows:[structuredClone(x)],rowCount:1});
const empty=()=>({rows:[],rowCount:0});
export function syntheticPool({conflict=false,corruptReadback=false}={}) {
  let binding=null, head=conflict?'1':'0', endorsement, owner;
  const records=[]; const calls=[];
  return {records,calls,getBinding:()=>binding,pool:{async connect(){return {
    release(){},
    // oxlint-disable-next-line complexity -- each branch dispatches on one exact SQL statement shape the real PA repositories issue; splitting it would separate directly-paired cases
    async query(sql,values=[]) {
      calls.push({sql,values:structuredClone(values)});
      if(sql.startsWith('SELECT version')) {return row({version:sql.includes('pa-operation-dispatch-v2')?2:1,
        digest:await (sql.includes('pa-operation-dispatch-v2')?dispatchOperationSchemaDigest:sql.includes('pa-route-selection-v1')?routeSelectionSchemaDigest:materializationPostgresSchemaDigest)()});}
      if(sql.startsWith('SELECT head_version') || sql.startsWith('SELECT binding,head_version')) {return row({binding,head_version:head});}
      if(sql.startsWith('UPDATE provider_access.materialization_owner')) {binding=JSON.parse(values[5]);head=values[6];return {rows:[],rowCount:1};}
      if(sql.startsWith('SELECT binding FROM')){return row({binding:corruptReadback?{...binding,credentialGeneration:99}:binding});}
      if(sql.startsWith('SELECT binding_revision')){return endorsement?row(endorsement):empty();}
      if(sql.startsWith('INSERT INTO provider_access.route_selection(')) {endorsement={binding_revision:values[1],head_version:values[2],endorsement:JSON.parse(values[3])};return {rows:[],rowCount:1};}
      if(sql.startsWith('INSERT INTO provider_access.dispatch_operation_owner_v2')) {owner=JSON.parse(values[1]);return {rows:[],rowCount:1};}
      if(sql.startsWith('SELECT owner FROM')){return row({owner});}
      if(sql.startsWith('UPDATE provider_access.dispatch_operation_owner_v2')){return row({control_time:'1000'});}
      if(sql.startsWith('SELECT record FROM')) {const found=records.find(r=>r.key===values[2]);return found?row({record:found.record}):empty();}
      if(sql.startsWith('INSERT INTO provider_access.dispatch_operation_record_v2')) {records.push({key:values[2],record:JSON.parse(values[3])});return {rows:[],rowCount:1};}
      if(/^(BEGIN|COMMIT|ROLLBACK|SET|SELECT set_config|SELECT pg_advisory|CREATE|INSERT INTO provider_access.materialization_owner)/.test(sql)) {return empty();}
      throw new Error('Unexpected synthetic SQL');
    }
  };}}};
}
