import type { Client } from "pg"

const MAX_VALUES_BY_TYPE = new Map([
  ["bigint", "9223372036854775807"],
  ["integer", "2147483647"],
  ["smallint", "32767"],
])

export const getSequences = async (client: Client) => {
  const { rows } = await client.query<{
    cache_size: number
    cycle: boolean
    data_type: string
    increment_by: string
    max_value: string
    min_value: string
    name: string
    owner_name: string
    schema_name: string
    start_value: string
  }>(`
  select
    s.schemaname::regnamespace as schema_name
    , s.sequencename::regclass as name
    , s.sequenceowner::regrole as owner_name
    , s.data_type::regtype as data_type
    , s.start_value
    , s.min_value
    , s.max_value
    , s.increment_by
    , s.cycle
    , s.cache_size
  from pg_catalog.pg_sequences s
  where
    s.schemaname not in ('pg_catalog', 'information_schema')
  order by
    s.schemaname, s.sequencename`)

  return rows.map(
    ({
      cache_size,
      cycle,
      data_type,
      increment_by,
      max_value,
      min_value,
      name,
      schema_name,
      start_value,
    }) =>
      [
        `CREATE SEQUENCE ${schema_name}.${name}`,
        `    START WITH ${start_value}`,
        `    INCREMENT BY ${increment_by}`,
        min_value === start_value
          ? "    NO MINVALUE"
          : `    MINVALUE ${min_value}`,
        max_value === MAX_VALUES_BY_TYPE.get(data_type)
          ? "    NO MAXVALUE"
          : `    MAXVALUE ${max_value}`,
        ...(cycle ? ["    CYCLE"] : []),
        `    CACHE ${cache_size};`,
      ].join("\n"),
  )
}
