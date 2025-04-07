import type { Client } from "pg"

export const getFunctions = async (client: Client) => {
  const { rows } = await client.query<{
    function_arguments: string
    function_definition: string
    function_name: string
    owner_name: string
    schema_name: string
  }>(`
  select
    pg_namespace.nspname as schema_name
    , pg_proc.proname as function_name
    , pg_get_userbyid(pg_proc.proowner) as owner_name
    , pg_catalog.pg_get_function_identity_arguments(pg_proc.oid) as function_arguments
    , pg_catalog.pg_get_functiondef(pg_proc.oid) as function_definition
  from pg_catalog.pg_proc
  inner join pg_catalog.pg_namespace on
    pg_namespace.oid = pg_proc.pronamespace
  inner join pg_catalog.pg_language on
    pg_language.oid = pg_proc.prolang
  where
    pg_catalog.pg_function_is_visible(pg_proc.oid)
    and pg_namespace.nspname not in ('pg_catalog', 'information_schema')
    and pg_proc.probin is null
    and pg_language.lanname != 'internal'
    and pg_proc.prokind != 'a'
  order by
    pg_namespace.nspname
    , pg_proc.proname;`)

  return rows
    .map(
      ({
        function_arguments,
        function_definition,
        function_name,
        owner_name,
        schema_name,
      }) =>
        [
          `${function_definition.trimEnd()};`,
          "\n",
          `ALTER FUNCTION ${schema_name}.${function_name}(${function_arguments}) OWNER TO ${owner_name};`,
        ].join("\n"),
    )
    .join("\n\n")
}
