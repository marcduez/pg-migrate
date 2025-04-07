import type { Client } from "pg"

export const getExtensions = async (client: Client) => {
  const { rows } = await client.query<{
    extension_comment: string
    extension_name: string
    schema_name: string
  }>(`
  select
    pg_namespace.nspname AS schema_name
    , pg_extension.extname as extension_name
    , pg_description.description AS extension_comment
  from pg_catalog.pg_extension 
  inner join pg_catalog.pg_namespace on
    pg_namespace.oid = pg_extension.extnamespace
  left join pg_catalog.pg_description on
    pg_description.objoid = pg_extension.oid
    and pg_description.classoid = 'pg_catalog.pg_extension'::pg_catalog.regclass
  where
    pg_namespace.nspname not in ('pg_catalog', 'information_schema');`)

  return rows
    .flatMap(({ extension_comment, extension_name, schema_name }) => {
      const escapedComment = client.escapeLiteral(extension_comment)
      return [
        `CREATE EXTENSION IF NOT EXISTS ${extension_name} WITH SCHEMA ${schema_name};`,
        `COMMENT ON EXTENSION ${extension_name} IS ${escapedComment};`,
      ]
    })
    .join("\n\n")
}
