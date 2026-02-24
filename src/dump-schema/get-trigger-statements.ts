import type { Client } from "pg"

/**
 * Returns a `CREATE TRIGGER` statement for each trigger.
 * Returns an `ALTER TABLE ... ENABLE/DISABLE TRIGGER` statement for each trigger that is disabled or replica/always enabled.
 * Returns a `COMMENT ON TRIGGER` statement for each trigger with a defined comment.
 */
export const getTriggerStatements = async (client: Client) => {
  const { rows } = await client.query<{
    comment: string | null
    definition: string
    enabled_status: string
    schema_name: string
    table_name: string
    trigger_name: string
  }>(`
  select
    quote_ident(t.tgname) AS trigger_name
    , table_cl.relnamespace::regnamespace as schema_name
    , t.tgrelid::regclass AS table_name
    , pg_catalog.pg_get_triggerdef(t.oid) AS definition
    , t.tgenabled AS enabled_status
    , quote_literal(d.description) as comment
  from pg_catalog.pg_trigger t
  inner join pg_catalog.pg_class table_cl on
    table_cl.oid = t.tgrelid
  inner join pg_catalog.pg_namespace ns on
    ns.oid = table_cl.relnamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  left join pg_catalog.pg_description d on
    d.objoid = t.oid
    and d.classoid = 'pg_catalog.pg_trigger'::regclass
  where
    not t.tgisinternal
  order by t.tgname::text, ns.nspname::text, table_cl.relname::text`)

  return rows.flatMap(
    ({
      comment,
      definition,
      enabled_status,
      schema_name,
      table_name,
      trigger_name,
    }) => [
      `${definition.trimEnd()};`,
      ...(enabled_status === "D"
        ? [
            `ALTER TABLE ${schema_name}.${table_name} DISABLE TRIGGER ${trigger_name};`,
          ]
        : []),
      ...(enabled_status === "R"
        ? [
            `ALTER TABLE ${schema_name}.${table_name} ENABLE REPLICA TRIGGER ${trigger_name};`,
          ]
        : []),
      ...(enabled_status === "A"
        ? [
            `ALTER TABLE ${schema_name}.${table_name} ENABLE ALWAYS TRIGGER ${trigger_name};`,
          ]
        : []),
      ...(comment
        ? [
            `COMMENT ON TRIGGER ${trigger_name} ON ${schema_name}.${table_name} IS ${comment};`,
          ]
        : []),
    ],
  )
}
