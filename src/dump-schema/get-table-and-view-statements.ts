import { type Client } from "pg"

/**
 * Returns `CREATE TABLE` / `CREATE VIEW` statements, skipping any tables and views that are hoisted by `getFunctionStatements`.
 * Returns `ALTER TABLE ONLY ... ATTACH PARTITION` statements to attach partitions for each partitioned table.
 * Returns `ALTER TABLE ONLY ... ADD CONSTRAINT` statements to add non-foreign key constraints for each table.
 * Returns `COMMENT ON CONSTRAINT` statement for each constraint with a defined comment.
 */
export const getTableAndViewStatements = async (
  client: Client,
  createTableAndViewStatements: {
    tableOrViewName: string
    statements: string[]
  }[],
  hoistedTablesAndViewNames: string[],
) => {
  const { rows: nonForeignKeyConstraintRows } = await client.query<{
    comment: string | null
    definition: string
    name: string
    schema_name: string
    table_name: string
  }>(`
  select
    con.connamespace::regnamespace as schema_name
    , con.conrelid::regclass as table_name
    , quote_ident(con.conname) as name
    , pg_catalog.pg_get_constraintdef(con.oid) as definition
    , quote_literal(d.description) as comment
  from pg_catalog.pg_constraint con
  inner join pg_catalog.pg_namespace ns on
    ns.oid = con.connamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  inner join pg_catalog.pg_class table_cl on
    table_cl.oid = con.conrelid
  left join pg_catalog.pg_description d on
    d.objoid = con.oid
    and d.classoid = 'pg_catalog.pg_constraint'::regclass
  where
    pg_catalog.pg_table_is_visible(con.conrelid)
     -- Where constraint is not foreign key constraint, as those are written later
    and con.contype != 'f'
  order by ns.nspname, table_cl.relname, con.conname`)

  const { rows: partitionedTableRows } = await client.query<{
    schema_name: string
    name: string
  }>(`
  select
    cl.relnamespace::regnamespace as schema_name
    , cl.oid::regclass as name
  from pg_catalog.pg_class cl
  inner join pg_catalog.pg_namespace ns on
    ns.oid = cl.relnamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  where
    -- Where kind is partition.
    cl.relkind = 'p'
  order by ns.nspname, cl.relname`)

  const attachPartitionCommands: string[] = []
  for (const { schema_name, name } of partitionedTableRows) {
    const tableName = `${schema_name}.${name}`
    const { rows: attachPartitionRows } = await client.query<{
      partition_definition: string
      partition_name: string
      schema_name: string
    }>(
      `
  select
    c.relnamespace::regnamespace as schema_name
    , p.relid::regclass AS partition_name
    , pg_get_expr(c.relpartbound, p.relid) AS partition_definition
  from pg_catalog.pg_partition_tree($1) p
  inner join pg_catalog.pg_class c on
    c.oid = p.relid
    and c.relispartition
  inner join pg_catalog.pg_namespace n on
    n.oid = c.relnamespace
  order by n.nspname, c.relname`,
      [tableName],
    )
    attachPartitionCommands.push(
      ...attachPartitionRows.map(
        ({ partition_definition, partition_name, schema_name }) =>
          `ALTER TABLE ONLY ${tableName} ATTACH PARTITION ${schema_name}.${partition_name} ${partition_definition};`,
      ),
    )
  }

  return createTableAndViewStatements
    .filter(
      ({ tableOrViewName }) =>
        !hoistedTablesAndViewNames.includes(tableOrViewName),
    )
    .flatMap(({ statements }) => statements)
    .concat(
      nonForeignKeyConstraintRows.flatMap(
        ({ comment, definition, name, schema_name, table_name }) => [
          [
            `ALTER TABLE ONLY ${schema_name}.${table_name}`,
            `    ADD CONSTRAINT ${name} ${definition};`,
          ].join("\n"),
          ...(comment
            ? [
                `COMMENT ON CONSTRAINT ${name} ON ${schema_name}.${table_name} IS ${comment};`,
              ]
            : []),
        ],
      ),
    )
    .concat(attachPartitionCommands)
}
