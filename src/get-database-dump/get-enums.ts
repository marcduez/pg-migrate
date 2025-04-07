import type { Client } from "pg"

export const getEnums = async (client: Client) => {
  const { rows } = await client.query<{
    enum_name: string
    enum_value: string
    owner_name: string
    schema_name: string
  }>(`
  select
    pg_namespace.nspname as schema_name
    , pg_type.typname as enum_name
    , pg_get_userbyid(pg_type.typowner) as owner_name
    , pg_enum.enumlabel as enum_value
    , pg_enum.enumsortorder as value_index
  from pg_catalog.pg_enum
  inner join pg_catalog.pg_type on
    pg_type.oid = pg_enum.enumtypid
  inner join pg_catalog.pg_namespace on
    pg_namespace.oid = pg_type.typnamespace
  where
    pg_namespace.nspname not in ('pg_catalog', 'information_schema')
  order by
    pg_namespace.nspname
    , pg_type.typname
    , pg_enum.enumsortorder;`)

  const dataByEnum = rows.reduce(
    (map, { enum_name, enum_value, owner_name, schema_name }) => {
      const newMap = new Map(map)
      const key = `${schema_name}.${enum_name}`
      const item = newMap.get(key)
      if (item) {
        item.values.push(enum_value)
      } else {
        newMap.set(key, { values: [enum_value], owner: owner_name })
      }
      return newMap
    },
    new Map<string, { values: string[]; owner: string }>(),
  )

  return [...dataByEnum.entries()]
    .sort(([enumNameA], [enumNameB]) => enumNameA.localeCompare(enumNameB))
    .map(([enumName, { values, owner }]) =>
      [
        `CREATE TYPE ${enumName} AS ENUM (`,
        values.map(value => `  '${value}'`).join(",\n"),
        ");",
        "",
        `ALTER TYPE ${enumName} OWNER TO ${owner};`,
      ].join("\n"),
    )
    .join("\n\n")
}
