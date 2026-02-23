import { type Client } from "pg"

/**
 * Returns a `COMMENT ON SCHEMA` statement for each schema with a defined comment.
 */
export const getSchemaComments = async (client: Client) => {
  const { rows } = await client.query<{
    comment: string
    name: string
  }>(`
  select
    ns.oid::regnamespace as name
    , quote_literal(d.description) as comment
  from pg_catalog.pg_namespace ns
  inner join pg_catalog.pg_description d on
    d.objoid = ns.oid
    and d.classoid = 'pg_catalog.pg_namespace'::regclass
  where
    ns.nspname != 'information_schema'
    and ns.nspname !~ '^pg_'
  order by ns.nspname`)

  return rows.map(
    ({ comment, name }) => `COMMENT ON SCHEMA ${name} IS ${comment};`,
  )
}
