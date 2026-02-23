import { type Client } from "pg"

/**
 * Returns an `ALTER TABLE ... ADD CONSTRAINT` statement for each foreign key constraint.
 * Returns a `COMMENT ON CONSTRAINT` statement for each foreign key constraint with a defined comment.
 */
export const getForeignKeyConstraintStatements = async (client: Client) => {
  const { rows } = await client.query<{
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
    -- Where type is a foreign key constraint.
    and con.contype = 'f'
  order by ns.nspname, table_cl.relname, con.conname`)

  return rows.flatMap(
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
  )
}
