import { Client } from "pg"

export const getIndexes = async (client: Client) => {
  const { rows: indexRows } = await client.query<{
    index_definition: string
    index_name: string
    schema_name: string
  }>(`
  select
    i.schemaname::regnamespace as schema_name
    , i.indexname::regclass as index_name
    , i.indexdef as index_definition
  from
    pg_catalog.pg_indexes i
  where
	  i.schemaname not in ('pg_catalog', 'information_schema')
    -- Where constraint is not already created by a primary key.
	  and not exists (
	    select
	    from pg_catalog.pg_constraint cn
	    inner join pg_catalog.pg_class cl on
        cl.oid = cn.conrelid
	    where
		    cl.relnamespace::regnamespace = i.schemaname::regnamespace
		    and cn.conname::regclass = i.indexname::regclass 
		    and cn.contype = 'p'
    )
  order by i.schemaname, i.indexname`)

  const { rows: indexPartitionRows } = await client.query<{
    index_name: string
    index_schema_name: string
    table_name: string
    table_schema_name: string
  }>(`
  select
    icl.relnamespace::regnamespace as index_schema_name,
    i.indexrelid::regclass AS index_name,
    tcl.relnamespace::regnamespace as table_schema_name,
    i.indrelid::regclass AS table_name
  from pg_catalog.pg_index i
  inner join pg_catalog.pg_class icl on
    icl.oid = i.indexrelid
  inner join pg_catalog.pg_namespace ins on
    ins.oid = icl.relnamespace
  inner join pg_catalog.pg_class tcl on
    tcl.oid = i.indrelid
  inner join pg_catalog.pg_namespace tns on
    tns.oid = tcl.relnamespace
  where
	  ins.nspname not in ('pg_catalog', 'information_schema')
    and tcl.relispartition = true
  order by ins.nspname, icl.relname, tns.nspname, tcl.relname`)

  const partitionsByIndex = new Map<string, string>(
    indexPartitionRows.map(
      ({ index_name, index_schema_name, table_name, table_schema_name }) => {
        return [
          `${index_schema_name}.${index_name}`,
          `${table_schema_name}.${table_name}`,
        ]
      },
    ),
  )

  return [
    ...indexRows.map(
      ({ index_definition }) => `${index_definition.trimEnd()};`,
    ),
    ...[...partitionsByIndex.entries()].map(
      ([indexName, partitionName]) =>
        `ALTER INDEX ${indexName} ATTACH PARTITION ${partitionName};`,
    ),
  ].join("\n\n\n")
}
