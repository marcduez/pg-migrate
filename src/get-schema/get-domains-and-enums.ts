import type { Client } from "pg"

export const getDomainsAndEnums = async (client: Client) => {
  const { rows } = await client.query<{
    comment: string | null
    domain_constraint_definition: string | null
    domain_constraint_name: string | null
    domain_underlying_type: string | null
    enum_value: string | null
    name: string
    owner_name: string
    row_type: "domain" | "enum"
    schema_name: string
  }>(`
  select 
    schema_name::regnamespace as schema_name
    , name::regtype as name
    , row_type
    , quote_literal(enum_value) as enum_value
    , quote_ident(domain_constraint_name) as domain_constraint_name
    , domain_constraint_definition
    , domain_underlying_type
    , owner_name::regrole as owner_name
    , quote_literal(comment) as comment
  from (
    -- Select domains
    select
      ns.nspname as schema_name
      , t.typname as name
      , 'domain' as row_type
      , null as enum_value
      , null as enum_sort_order
      , con.conname as domain_constraint_name
      , pg_get_constraintdef(con.oid) as domain_constraint_definition
      , pg_catalog.format_type(t.typbasetype, t.typtypmod) as domain_underlying_type
      , t.typowner as owner_name
      , d.description as comment
    from pg_catalog.pg_type t
    inner join pg_catalog.pg_namespace ns on
      ns.oid = t.typnamespace
      and ns.nspname not in ('pg_catalog', 'information_schema')
    left join pg_catalog.pg_constraint con on
      con.contypid = t.oid
    left join pg_catalog.pg_description d on
      d.objoid = t.oid
      and d.classoid = 'pg_catalog.pg_type'::regclass
    where
      -- Where type is domain
      t.typtype = 'd'

    union all

    -- Select enums
    select
      ns.nspname 
      , t.typname
      , 'enum' as row_type
      , e.enumlabel as enum_value
      , e.enumsortorder as enum_sort_order
      , null as domain_constraint_name
      , null as domain_constraint_definition
      , null as domain_underlying_type
      , t.typowner as owner_name
      , d.description as comment
    from pg_catalog.pg_enum e
    inner join pg_catalog.pg_type t on
      t.oid = e.enumtypid
      -- Where type is enum
      and t.typtype = 'e'
    inner join pg_catalog.pg_namespace ns on
      ns.oid = t.typnamespace
      and ns.nspname not in ('pg_catalog', 'information_schema')
    left join pg_catalog.pg_description d on
      d.objoid = t.oid
      and d.classoid = 'pg_catalog.pg_type'::regclass
  )
  order by schema_name, name, enum_sort_order, domain_constraint_name`)

  return rows
    .reduce<
      {
        comment: string | null
        domainConstraints: string[]
        domainUnderlyingType: string | null
        enumValues: string[]
        name: string
        schemaName: string
        type: "enum" | "domain"
      }[]
    >(
      (
        arr,
        {
          comment,
          domain_constraint_definition,
          domain_constraint_name,
          domain_underlying_type,
          enum_value,
          name,
          row_type,
          schema_name,
        },
      ) => {
        let item = arr.find(
          item => item.schemaName === schema_name && item.name === name,
        )
        if (!item) {
          item = {
            comment,
            domainConstraints: [],
            domainUnderlyingType: null,
            enumValues: [],
            name,
            schemaName: schema_name,
            type: row_type,
          }
          arr.push(item)
        }
        if (row_type === "enum") {
          // Enum type
          item.enumValues.push(`    ${enum_value!}`)
        } else {
          // Domain type
          item.domainUnderlyingType = domain_underlying_type
          if (domain_constraint_name) {
            item.domainConstraints.push(
              `    CONSTRAINT ${domain_constraint_name} ${domain_constraint_definition!}`,
            )
          }
        }
        return arr
      },
      [],
    )
    .flatMap(
      ({
        comment,
        domainConstraints,
        domainUnderlyingType,
        enumValues,
        name,
        schemaName,
        type,
      }) => {
        if (type === "enum") {
          return [
            [
              `CREATE TYPE ${schemaName}.${name} AS ENUM (`,
              enumValues.join(",\n"),
              ");",
            ].join("\n"),
            ...(comment
              ? [`COMMENT ON TYPE ${schemaName}.${name} IS ${comment};`]
              : []),
          ]
        }

        const createCommand = `CREATE DOMAIN ${schemaName}.${name} AS ${domainUnderlyingType}`
        return [
          domainConstraints.length
            ? [createCommand, domainConstraints.join("\n") + ";"].join("\n")
            : `${createCommand};`,
          ...(comment
            ? [`COMMENT ON DOMAIN ${schemaName}.${name} IS ${comment};`]
            : []),
        ]
      },
    )
}
