import type { PoolClient } from "pg";

/** Re-running the migration must detect missing retention and stale-binary fences. */
export const validateContainedTurnIntentCatalog = async (client: PoolClient): Promise<void> => {
  const tables = await client.query<{
    columns: number; constraints: number; name: string; policy: boolean; retention: boolean; rls: boolean; write_fence: boolean;
  }>(`SELECT c.relname AS name, c.relrowsecurity AND c.relforcerowsecurity AS rls,
      (SELECT count(*)::integer FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT count(*)::integer FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype IN ('c','p','u','f') AND k.convalidated) AS constraints,
      EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='contained_turn_runtime_schema_fence'
        AND p.polcmd='*' AND p.polpermissive
        AND pg_get_expr(p.polqual,p.polrelid) LIKE '%contained_turn_runtime_schema_compatible()%'
        AND pg_get_expr(p.polwithcheck,p.polrelid) LIKE '%contained_turn_runtime_schema_compatible()%') AS policy,
      EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='contained_turn_intent_retention'
        AND t.tgenabled IN ('O','A') AND t.tgtype=58
        AND t.tgfoid='agent_execution.reject_contained_turn_intent_retirement()'::regprocedure) AS retention,
      EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='contained_turn_runtime_schema_write_fence'
        AND t.tgenabled IN ('O','A') AND t.tgtype=31
        AND t.tgfoid='agent_execution.reject_incompatible_contained_turn_runtime_write()'::regprocedure) AS write_fence
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='agent_execution' AND c.relname IN (
      'contained_turn_intent_namespace_v1', 'contained_turn_intent_v1', 'contained_turn_intent_guard_v1')`);
  const expected = new Map([
    ["contained_turn_intent_namespace_v1", [3, 4]],
    ["contained_turn_intent_v1", [6, 6]],
    ["contained_turn_intent_guard_v1", [7, 7]],
  ]);
  if (tables.rows.length !== expected.size || tables.rows.some(row => {
    const shape = expected.get(row.name);
    return shape === undefined || row.columns !== shape[0] || row.constraints !== shape[1] ||
      !row.rls || !row.policy || !row.retention || !row.write_fence;
  })) {throw new Error("contained turn PostgreSQL v7 intent catalog drift detected");}
};
