import { type Client } from "pg"

export const getFunctions = async (client: Client) => {
  const { rows: functionRows } = await client.query<{
    args: string
    comment: string | null
    definition: string
    name: string
    owner_name: string
    schema_name: string
  }>(`
  select
    p.pronamespace::regnamespace as schema_name
    , p.oid::regproc as name
    , p.proowner::regrole as owner_name
    , pg_catalog.pg_get_function_identity_arguments(p.oid) as args
    , pg_catalog.pg_get_functiondef(p.oid) as definition
	  , quote_literal(d.description) as comment
  from pg_catalog.pg_proc p
  inner join pg_catalog.pg_namespace n on
    n.oid = p.pronamespace
    and n.nspname not in ('pg_catalog', 'information_schema')
  inner join pg_catalog.pg_language l on
    l.oid = p.prolang
    and l.lanname != 'internal'
  left join pg_catalog.pg_description d on
  	d.objoid = p.oid
  	and d.classoid = 'pg_catalog.pg_proc'::regclass
  where
    pg_catalog.pg_function_is_visible(p.oid)
    and p.probin is null
    and p.prokind != 'a'
  order by n.nspname, p.proname`)

  const { rows: aggregateRows } = await client.query<{
    args: string
    comment: string | null
    final_function_name: string | null
    initial_condition: string | null
    name: string
    schema_name: string
    state_transition_function_name: string
    state_type: string
  }>(`
  select
    p.pronamespace::regnamespace as schema_name
    , p.oid::regproc as name
    , pg_catalog.pg_get_function_identity_arguments(p.oid) as args
    , a.aggtransfn::regproc as state_transition_function_name
    , a.aggtranstype::regtype as state_type
    , a.aggfinalfn::regproc as final_function_name
    , quote_literal(a.agginitval) AS initial_condition
    , quote_literal(d.description) as comment
  from pg_catalog.pg_aggregate a
  inner join pg_catalog.pg_proc p on
    p.oid = a.aggfnoid
    and p.prokind = 'a'
  inner join pg_catalog.pg_namespace n on
    n.oid = p.pronamespace
    and n.nspname not in ('pg_catalog', 'information_schema')
  left join pg_catalog.pg_description d on
  	d.objoid = p.oid
  	and d.classoid = 'pg_catalog.pg_proc'::regclass
  where
    pg_catalog.pg_function_is_visible(p.oid)
  order by n.nspname, p.proname`)

  return functionRows
    .map(({ args, comment, definition, name, schema_name }) =>
      [
        `${definition.trimEnd()};`,
        ...(comment
          ? [
              "",
              "",
              `COMMENT ON FUNCTION ${schema_name}.${name}(${args}) IS ${comment};`,
            ]
          : []),
      ].join("\n"),
    )
    .concat(
      aggregateRows.map(
        ({
          args,
          comment,
          final_function_name,
          initial_condition,
          name,
          schema_name,
          state_transition_function_name,
          state_type,
        }) => {
          return [
            `CREATE AGGREGATE ${schema_name}.${name}(${args}) (`,
            [
              ...(state_transition_function_name
                ? [
                    `   SFUNC = ${schema_name}.${state_transition_function_name}`,
                  ]
                : []),
              `   STYPE = ${state_type}`,
              ...(final_function_name !== "-"
                ? [`    FINALFUNC = ${schema_name}.${final_function_name}`]
                : []),
              ...(initial_condition
                ? [`    INITCOND = ${initial_condition}`]
                : []),
            ].join(",\n"),
            ");",
            ...(comment
              ? [
                  "",
                  "",
                  `COMMENT ON FUNCTION ${schema_name}.${name}(${args}) IS ${comment};`,
                ]
              : []),
          ].join("\n")
        },
      ),
    )
    .join("\n\n\n")
}
