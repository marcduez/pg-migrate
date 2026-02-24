import { type Client } from "pg"

/**
 * Returns a `CREATE EXTENSION IF NOT EXISTS` statement for each extension.
 * Returns a `COMMENT ON EXTENSION` statement for each extension with a defined comment.
 */
export const getExtensionStatements = async (client: Client) => {
  const { rows } = await client.query<{
    comment: string
    name: string
    schema_name: string
  }>(`
  select
    quote_ident(e.extname) as name
    , e.extnamespace::regnamespace as schema_name
    , quote_literal(d.description) AS comment
  from pg_catalog.pg_extension e
  left join pg_catalog.pg_description d on
    d.objoid = e.oid
    and d.classoid = 'pg_catalog.pg_extension'::regclass
  where
    e.extnamespace::regnamespace not in ('pg_catalog', 'information_schema')
  order by e.extname::text, e.extnamespace::text`)

  return rows.flatMap(({ comment, name, schema_name }) => [
    `CREATE EXTENSION IF NOT EXISTS ${name} WITH SCHEMA ${schema_name};`,
    `COMMENT ON EXTENSION ${name} IS ${comment};`,
  ])
}
