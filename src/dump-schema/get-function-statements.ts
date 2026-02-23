import { type Client } from "pg"

/**
 * Returns a `CREATE FUNCTION` statement for each function.
 * Returns a `CREATE AGGREGATE` statement for each aggregate.
 * Returns a `COMMENT ON FUNCTION` statement for each function with a defined comment.
 * Returns a `COMMENT ON AGGREGATE` statement for each aggregate with a defined comment.
 * Returns a `CREATE TABLE` / `CREATE VIEW` statement for each type required by functions or aggregates.
 */
export const getFunctionStatements = async (
  client: Client,
  createTableAndViewStatements: {
    tableOrViewName: string
    statements: string[]
  }[],
  hoistedTablesAndViewNames: string[],
) => {
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
  inner join pg_catalog.pg_namespace ns on
    ns.oid = p.pronamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
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
    -- Where function was not created by an extension.
    and not exists (
      select
        *
      from pg_catalog.pg_depend dep
      where
        dep.objid = p.oid
        and dep.deptype = 'e'
    )
  order by ns.nspname, p.proname`)

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
    -- Where aggregate was not created by an extension.
    and not exists (
      select
        *
      from pg_catalog.pg_depend dep
      where
        dep.objid = a.aggfnoid
        and dep.deptype = 'e'
    )
  order by n.nspname, p.proname`)

  const { rows: requiredTypeRows } = await client.query<{
    name: string
    schema_name: string
    type_name: string
    type_schema_name: string
  }>(`
  select
    t.typnamespace::regnamespace as schema_name
    , t.typname::regtype as type_name
  from pg_catalog.pg_proc p
  inner join pg_catalog.pg_depend d on
    -- Where the dependency parent is a procedure
    d.objid = p.oid
    and d.classid = 'pg_catalog.pg_proc'::regclass
    -- Where the dependency child is a type
    and d.refclassid = 'pg_catalog.pg_type'::regclass
  inner join pg_catalog.pg_type t on
    t.oid = d.refobjid
  inner join pg_catalog.pg_language l on
    l.oid = p.prolang
    and l.lanname != 'internal'
  where
    pg_catalog.pg_function_is_visible(p.oid)
    and p.probin is null
  order by t.typnamespace, t.typname`)

  const distinctRequiredSchemaAndTypeNames = [
    ...requiredTypeRows.reduce((set, row) => {
      set.add(`${row.schema_name}.${row.type_name}`)
      return set
    }, new Set<string>()),
  ]

  return distinctRequiredSchemaAndTypeNames
    .flatMap(schemaAndTypeName => {
      // Hoist `CREATE TABLE` / `CREATE VIEW` statement if it describes a type required by a function.
      const statements =
        createTableAndViewStatements.find(
          ({ tableOrViewName }) => tableOrViewName === schemaAndTypeName,
        )?.statements ?? []
      if (statements.length) {
        hoistedTablesAndViewNames.push(schemaAndTypeName)
      }
      return statements
    })
    .concat(
      functionRows
        .flatMap(({ args, comment, definition, name, schema_name }) => [
          `${definition
            .replaceAll(/^CREATE OR REPLACE FUNCTION/g, "CREATE FUNCTION")
            .trimEnd()};`,
          ...(comment
            ? [
                `COMMENT ON FUNCTION ${schema_name}.${name}(${args}) IS ${comment};`,
              ]
            : []),
        ])
        .concat(
          aggregateRows.flatMap(
            ({
              args,
              comment,
              final_function_name,
              initial_condition,
              name,
              schema_name,
              state_transition_function_name,
              state_type,
            }) => [
              [
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
              ].join("\n"),
              ...(comment
                ? [
                    `COMMENT ON AGGREGATE ${schema_name}.${name}(${args}) IS ${comment};`,
                  ]
                : []),
            ],
          ),
        ),
    )
}
