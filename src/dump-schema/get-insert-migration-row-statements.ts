import { Client } from "pg"

export const getInsertMigrationRowStatements = async (
  client: Client,
  migrationTableName: string,
) => {
  const { rows } = await client.query<{
    filename: string
    md5: string
  }>(`
    select
      quote_literal(filename) as filename
      , quote_literal(md5) as md5
    from public.${migrationTableName}
    order by filename`)

  return rows.map(
    ({ filename, md5 }) =>
      `INSERT INTO public.${migrationTableName} (filename, md5) VALUES (${filename}, ${md5});`,
  )
}
