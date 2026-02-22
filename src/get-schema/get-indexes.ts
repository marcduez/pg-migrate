import { Client } from "pg"

export const getIndexes = async (client: Client) => {
  const { rows: indexRows } = await client.query<{
    definition: string
    name: string
    schema_name: string
  }>(`
  select
    i.schemaname::regnamespace as schema_name
    , i.indexname::regclass as name
    , i.indexdef as definition
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
    ...indexRows.map(({ definition }) => `${definition.trimEnd()};`),
    ...indexPartitionRows.map(
      ({ name, schema_name, parent_name, parent_schema_name }) =>
        `ALTER INDEX ${parent_schema_name}.${parent_name} ATTACH PARTITION ${schema_name}.${name};`,
    ),
  ].join("\n\n\n")
}
