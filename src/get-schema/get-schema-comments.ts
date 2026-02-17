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
    n.oid::regnamespace as name
    , quote_literal(d.description) as comment
  from pg_catalog.pg_namespace n
  -- Inner join on comments to only return schemas with comments
  inner join pg_catalog.pg_description d on
  	d.objoid = n.oid
  	and d.classoid = 'pg_catalog.pg_namespace'::regclass
  where
    n.nspname != 'information_schema'
    and n.nspname !~ '^pg_'
  order by n.nspname`)

  return rows
    .map(({ comment, name }) => `COMMENT ON SCHEMA ${name} IS ${comment};`)
    .join("\n\n\n")
}
