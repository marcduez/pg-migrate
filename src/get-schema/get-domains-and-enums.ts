import type { Client } from "pg"

export const getDomainsAndEnums = async (client: Client) => {
  const { rows: domainRows } = await client.query<{
    comment: string | null
    constraint_definition: string | null
    constraint_name: string | null
    name: string
    owner_name: string
    schema_name: string
    underlying_type: string
  }>(`
  select
    t.typnamespace::regnamespace as schema_name
    , t.oid::regtype as name
    , quote_ident(c.conname) as constraint_name
    , pg_get_constraintdef(c.oid) as constraint_definition
    , pg_catalog.format_type(t.typbasetype, t.typtypmod) as underlying_type
	  , t.typowner::regrole as owner_name
	  , quote_literal(d.description) as comment
  from pg_catalog.pg_type t
  inner join pg_catalog.pg_namespace n on
    n.oid = t.typnamespace
    and n.nspname not in ('pg_catalog', 'information_schema')
  left join pg_catalog.pg_constraint c on
	  c.contypid = t.oid
  left join pg_catalog.pg_description d on
  	d.objoid = t.oid
  	and d.classoid = 'pg_catalog.pg_type'::regclass
  where
    -- Where type is domain
    t.typtype = 'd'
  order by n.nspname, t.typname, c.conname`)

  const { rows: enumRows } = await client.query<{
    comment: string | null
    name: string
    owner_name: string
    schema_name: string
    value: string
  }>(`
  select
    t.typnamespace::regnamespace as schema_name
    , t.oid::regtype as name
    , quote_literal(e.enumlabel) as value
	  , t.typowner::regrole as owner_name
	  , quote_literal(d.description) as comment
  from pg_catalog.pg_enum e
  inner join pg_catalog.pg_type t on
    t.oid = e.enumtypid
    and t.typtype = 'e'
  inner join pg_catalog.pg_namespace n on
    n.oid = t.typnamespace
    and n.nspname not in ('pg_catalog', 'information_schema')
  left join pg_catalog.pg_description d on
  	d.objoid = t.oid
  	and d.classoid = 'pg_catalog.pg_type'::regclass
  order by n.nspname, t.typname, e.enumsortorder`)

  const dataByName: Map<
    string,
    | {
        type: "enum"
        comment: string | null
        owner: string
        values: string[]
      }
    | {
        type: "domain"
        comment: string | null
        constraints: string[]
        owner: string
        underlyingType: string
      }
  > = new Map()

  domainRows.forEach(
    ({
      comment,
      constraint_definition,
      constraint_name,
      name,
      owner_name,
      schema_name,
      underlying_type,
    }) => {
      const key = `${schema_name}.${name}`
      const constraint = constraint_name
        ? `CONSTRAINT ${constraint_name} ${constraint_definition || ""}`
        : null

      if (!dataByName.has(key)) {
        dataByName.set(key, {
          comment,
          constraints: constraint ? [constraint] : [],
          owner: owner_name,
          underlyingType: underlying_type,
          type: "domain",
        })
        return
      }

      const data = dataByName.get(key)!
      if (data.type !== "domain") {
        throw new Error(
          `Was expected ${key} to be a domain, but it was an enum`,
        )
      }

      if (constraint) {
        data.constraints.push(constraint)
      }
    },
  )

  enumRows.forEach(({ comment, name, owner_name, schema_name, value }) => {
    const key = `${schema_name}.${name}`

    if (!dataByName.has(key)) {
      dataByName.set(key, {
        comment,
        owner: owner_name,
        values: [value],
        type: "enum",
      })
      return
    }

    const data = dataByName.get(key)!
    if (data.type !== "enum") {
      throw new Error(`Was expected ${key} to be an enum, but it was a domain`)
    }
    data.values.push(value)
  })

  return [...dataByName.entries()]
    .sort(([nameA], [nameB]) => nameA.localeCompare(nameB))
    .map(([name, data]) => {
      if (data.type === "enum") {
        return [
          `CREATE TYPE ${name} AS ENUM (`,
          data.values.map(value => `  ${value}`).join(",\n"),
          ");",
          ...(data.comment
            ? ["", "", `COMMENT ON TYPE ${name} IS ${data.comment};`]
            : []),
        ].join("\n")
      }

      const createCommand = `CREATE DOMAIN ${name} AS ${data.underlyingType}`
      return [
        ...(data.constraints.length
          ? [
              createCommand,
              data.constraints
                .map(constraint => `  ${constraint}`)
                .join(",\n") + ";",
            ]
          : [`${createCommand};`]),
        ...(data.comment
          ? ["", "", `COMMENT ON DOMAIN ${name} IS ${data.comment};`]
          : []),
      ].join("\n")
    })
    .join("\n\n\n")
}
