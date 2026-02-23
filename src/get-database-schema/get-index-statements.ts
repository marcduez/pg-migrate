import { Client } from "pg"

/**
 * Returns a `CREATE INDEX` / `CREATE UNIQUE INDEX` statement for each index that was not created by a constraint.
 * Returns `ALTER INDEX ... ATTACH PARTITION` statement for each partitioned index.
 * Returns a `COMMENT ON INDEX` statement for each index with a defined comment.
 */
export const getIndexStatements = async (client: Client) => {
  const { rows: indexRows } = await client.query<{
    comment: string | null
    definition: string
    is_created_by_constraint: boolean
    name: string
    schema_name: string
  }>(`
  select
    cl.relnamespace::regnamespace as schema_name
    , i.indexrelid::regclass as name
    , pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    , quote_literal(d.description) as comment
    , (con.oid is not null) as is_created_by_constraint
  from pg_catalog.pg_index i
  inner join pg_catalog.pg_class cl on
    cl.oid = i.indexrelid
    and cl.relnamespace::regnamespace not in ('pg_catalog', 'information_schema')
  inner join pg_catalog.pg_namespace ns on
    ns.oid = cl.relnamespace
  inner join pg_catalog.pg_class table_cl on
    table_cl.oid = i.indrelid
  left join pg_constraint con on
    con.conindid = i.indexrelid
  left join pg_catalog.pg_description d on
    d.objoid = i.indexrelid
    and d.classoid = 'pg_catalog.pg_class'::regclass
  where
    not i.indisprimary
  order by cl.relname, ns.nspname, table_cl.relname`)

  const { rows: indexPartitionRows } = await client.query<{
    parent_schema_name: string
    parent_name: string
    schema_name: string
    name: string
  }>(`
  select
    parent_con.connamespace::regnamespace as parent_schema_name
    , parent_con.conname::regclass as parent_name
    , con.connamespace::regnamespace as schema_name
    , con.conname::regclass as name
  from
    pg_catalog.pg_constraint con
    inner join pg_constraint parent_con on
      parent_con.oid = con.conparentid 
  where
    con.connamespace::regnamespace not in ('pg_catalog', 'information_schema')
  order by parent_con.connamespace, parent_con.conname, con.connamespace, con.conname`)

  return [
    ...indexRows.flatMap(
      ({
        comment,
        definition,
        is_created_by_constraint,
        name,
        schema_name,
      }) => [
        ...(is_created_by_constraint ? [] : [`${definition.trimEnd()};`]),
        ...(comment
          ? [`COMMENT ON INDEX ${schema_name}.${name} IS ${comment};`]
          : []),
      ],
    ),
    ...indexPartitionRows.map(
      ({ name, schema_name, parent_name, parent_schema_name }) =>
        `ALTER INDEX ${parent_schema_name}.${parent_name} ATTACH PARTITION ${schema_name}.${name};`,
    ),
  ]
}
