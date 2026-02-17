import { Client } from "pg"

export const getIndexes = async (client: Client) => {
  const { rows: indexRows } = await client.query<{
    index_definition: string
    index_name: string
    schema_name: string
  }>(`
  -- select all primary key constraints
  with cte_primary_keys as (
    select
	    n.nspname as schema_name
	    , cl.relname as table_name
	    , cn.conname as constraint_name
	    , cn.contype as constraint_type
    from pg_catalog.pg_constraint cn
    inner join pg_catalog.pg_class cl on
      cl.oid = cn.conrelid
    inner join pg_catalog.pg_namespace n on 
      n.oid = cl.relnamespace
    where
	    n.nspname not in ('pg_catalog', 'information_schema')
	    and cn.contype = 'p'
  )
  select
    quote_ident(i.schemaname) as schema_name
    , quote_ident(i.indexname) as index_name
    , i.indexdef as index_definition
  from
    pg_catalog.pg_indexes i
  left join cte_primary_keys p on
    p.schema_name = i.schemaname
    and p.table_name = i.tablename
    and p.constraint_name = i.indexname
  where
    -- Where schema is not pg_catalog or information_schema.
    i.schemaname not in ('pg_catalog', 'information_schema')
    -- Where there is no primary key constraint with the same name.
    and p.schema_name  is null
  order by i.schemaname, i.indexname;`)

  const { rows: indexPartitionRows } = await client.query<{
    index_name: string
    index_schema_name: string
    table_name: string
    table_schema_name: string
  }>(`
  select
    quote_ident("in".nspname) as index_schema_name,
    quote_ident(icl.relname) AS index_name,
    quote_ident(tn.nspname) as table_schema_name,
    quote_ident(tcl.relname) AS table_name
  from pg_catalog.pg_index i
  inner join pg_catalog.pg_class icl on
    icl.oid = i.indexrelid
  inner join pg_catalog.pg_namespace "in" on
    "in".oid = icl.relnamespace
  inner join pg_catalog.pg_class tcl on
    tcl.oid = i.indrelid
  inner join pg_catalog.pg_namespace tn on
    tn.oid = tcl.relnamespace
  where
	  "in".nspname not in ('pg_catalog', 'information_schema')
    and tcl.relispartition = true`)

  const partitionsByIndex = new Map<
    string,
    { schema_name: string; table_name: string }
  >(
    indexPartitionRows.map(
      ({ index_name, index_schema_name, table_name, table_schema_name }) => {
        return [
          `${index_schema_name}.${index_name}`,
          { schema_name: table_schema_name, table_name },
        ]
      },
    ),
  )

  console.log(partitionsByIndex)

  return indexRows
    .map(({ index_definition }) => `${index_definition.trimEnd()};`)
    .join("\n\n")
}
