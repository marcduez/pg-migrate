import { type Client } from "pg"

export const getTablesAndViews = async (client: Client) => {
  const { rows: columnRows } = await client.query<{
    comment: string | null
    default_value: string | null
    is_not_null: boolean
    name: string
    owner_name: string
    partition_columns: string[] | null
    partition_strategy: string | null
    schema_name: string
    table_comment: string | null
    table_name: string
    type: string
  }>(`
  select
    table_cl.relnamespace::regnamespace as schema_name
    , table_cl.relname::regclass as table_name
    , quote_ident(att.attname) as name
    , table_cl.relowner::regrole as owner_name
    , att.attnotnull as is_not_null
    , pg_catalog.format_type(att.atttypid, att.atttypmod) as type
    , pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) as default_value
    , part.partstrat as partition_strategy
    , array(
        select
          quote_ident(attname)
        from pg_attribute
        where
          attrelid = table_cl.oid
          and attnum = any(part.partattrs)
    ) as partition_columns
    , quote_literal(table_d.description) as table_comment
    , quote_literal(d.description) as comment
  from pg_catalog.pg_attribute att
  inner join pg_catalog.pg_class table_cl on
    table_cl.oid = att.attrelid
    -- Where table is an ordinary table or a partitioned table.
    and (
      table_cl.relkind = 'r'
      or table_cl.relkind = 'p'
    )
  inner join pg_catalog.pg_namespace ns on
    ns.oid = table_cl.relnamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  left join pg_catalog.pg_partitioned_table part on
    part.partrelid = table_cl.oid
  left join pg_catalog.pg_attrdef ad on
    att.atthasdef
    and ad.adrelid = att.attrelid
    and ad.adnum = att.attnum
  left join pg_catalog.pg_description table_d on
    table_d.objoid = att.attrelid
    and table_d.objsubid = 0
    and table_d.classoid = 'pg_catalog.pg_class'::regclass
  left join pg_catalog.pg_description d on
    d.objoid = att.attrelid
    and d.objsubid = att.attnum
    and d.classoid = 'pg_catalog.pg_class'::regclass
  where
    pg_catalog.pg_table_is_visible(table_cl.oid)
    and pg_type_is_visible(att.atttypid)  
    and att.attnum > 0
    and not att.attisdropped
  order by ns.nspname, table_cl.relname, att.attnum`)

  const { rows: constraintRows } = await client.query<{
    comment: string | null
    definition: string
    name: string
    schema_name: string
    table_name: string
  }>(`
  select
    con.connamespace::regnamespace as schema_name
    , con.conrelid::regclass as table_name
    , quote_ident(con.conname) as name
    , pg_catalog.pg_get_constraintdef(con.oid) as definition
    , quote_literal(d.description) as comment
  from pg_catalog.pg_constraint con
  inner join pg_catalog.pg_namespace ns on
    ns.oid = con.connamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  inner join pg_catalog.pg_class table_cl on
    table_cl.oid = con.conrelid
  left join pg_catalog.pg_description d on
    d.objoid = con.oid
    and d.classoid = 'pg_catalog.pg_constraint'::regclass
  where
    pg_catalog.pg_table_is_visible(con.conrelid)
  order by ns.nspname, table_cl.relname, con.conname`)

  const { rows: partitionedTableRows } = await client.query<{
    schema_name: string
    table_name: string
  }>(`
  select
    cl.relnamespace::regnamespace as schema_name
    , cl.oid::regclass as table_name
  from pg_catalog.pg_class cl
  inner join pg_catalog.pg_namespace ns on
    ns.oid = cl.relnamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  where
    -- Where kind is partition.
    cl.relkind = 'p'
  order by ns.nspname, cl.relname`)

  const { rows: viewRows } = await client.query<{
    comment: string | null
    definition: string
    is_materialized: boolean
    name: string
    schema_name: string
  }>(`
  select
    schemaname::regnamespace as schema_name
    , viewname::regclass as name
    , definition
    , quote_literal(comment) as comment
    , is_materialized
  from (
    select
      v.schemaname
      , v.viewname
      , v.definition
      , d.description as comment
      , false as is_materialized
    from pg_catalog.pg_views v
    inner join pg_catalog.pg_class cl on
      cl.relname = v.viewname
      -- Where kind is view.
      and cl.relkind = 'v'
    left join pg_catalog.pg_description d on
      d.objoid = cl.oid
      and d.objsubid = 0
      and d.classoid = 'pg_catalog.pg_class'::regclass
    where
      v.schemaname not in ('pg_catalog', 'information_schema')
    union all
    select
      v.schemaname
      , v.matviewname as viewname
      , v.definition
      , d.description as comment
      , true as is_materialized
    from pg_catalog.pg_matviews v
    inner join pg_catalog.pg_class cl on
      cl.relname = v.matviewname
      -- Where kind is materialized view.
      and cl.relkind = 'm'
    left join pg_catalog.pg_description d on
      d.objoid = cl.oid
      and d.objsubid = 0
      and d.classoid = 'pg_catalog.pg_class'::regclass
    where
      v.schemaname not in ('pg_catalog', 'information_schema')
  ) t
  order by schemaname, viewname`)

  const { rows: viewColumnCommentRows } = await client.query<{
    schema_name: string
    view_name: string
    name: string
    comment: string
  }>(`
  select
    view_cl.relnamespace::regnamespace as schema_name
    , view_cl.relname::regclass as view_name
    , quote_ident(att.attname) as name
    , quote_literal(d.description) as comment
  from pg_catalog.pg_attribute att
  inner join pg_catalog.pg_class view_cl on
    view_cl.oid = att.attrelid
    and (
      view_cl.relkind = 'v'
      or view_cl.relkind = 'm'
    )
  inner join pg_catalog.pg_namespace ns on
    ns.oid = view_cl.relnamespace
    and ns.nspname not in ('pg_catalog', 'information_schema')
  inner join pg_catalog.pg_description d on
    d.objoid = att.attrelid
    and d.objsubid = att.attnum
    and d.classoid = 'pg_catalog.pg_class'::regclass
  where
    pg_catalog.pg_table_is_visible(view_cl.oid)
    and pg_type_is_visible(att.atttypid)  
    and att.attnum > 0
    and not att.attisdropped
  order by ns.nspname, view_cl.relname, att.attnum`)

  const partitionsByTableName = new Map<
    string,
    {
      schema_name: string
      partition_name: string
      partition_definition: string
    }[]
  >()

  for (const partitionedTableRow of partitionedTableRows) {
    const key = `${partitionedTableRow.schema_name}.${partitionedTableRow.table_name}`
    const { rows: partitionRows } = await client.query<{
      schema_name: string
      partition_name: string
      partition_definition: string
    }>(
      `
    select
	    c.relnamespace::regnamespace as schema_name
	    , p.relid::regclass AS partition_name
	    , pg_get_expr(c.relpartbound, p.relid) AS partition_definition
    from pg_partition_tree($1) p
    inner join pg_catalog.pg_class c on
	    c.oid = p.relid
	    and c.relispartition
	  inner join pg_catalog.pg_namespace n on
  	  n.oid = c.relnamespace
    order by n.nspname, c.relname`,
      [key],
    )
    partitionRows.forEach(
      ({ schema_name, partition_name, partition_definition }) => {
        if (!partitionsByTableName.has(key)) {
          partitionsByTableName.set(key, [])
        }
        partitionsByTableName
          .get(key)!
          .push({ schema_name, partition_name, partition_definition })
      },
    )
  }

  const tableColumns = columnRows.reduce(
    (
      map,
      {
        comment,
        default_value,
        is_not_null,
        name,
        partition_columns,
        partition_strategy,
        schema_name,
        table_comment,
        table_name,
        type,
      },
    ) => {
      const tableName = `${schema_name}.${table_name}`
      const notNullClause = is_not_null ? " NOT NULL" : ""
      const defaultClause = default_value ? ` DEFAULT ${default_value}` : ""
      const columnLine = `${name} ${type}${defaultClause}${notNullClause}`

      const commentLine = table_comment
        ? `COMMENT ON TABLE ${tableName} IS ${table_comment};`
        : null
      const columnCommentLine = comment
        ? `COMMENT ON COLUMN ${tableName}.${name} IS ${comment};`
        : null

      let partitionLine: string | null
      const partitionColumnList = (partition_columns ?? []).join(", ")
      switch (partition_strategy) {
        case "r":
          partitionLine = `PARTITION BY RANGE (${partitionColumnList});`
          break
        case "l":
          partitionLine = `PARTITION BY LIST (${partitionColumnList});`
          break
        case "h":
          partitionLine = `PARTITION BY HASH (${partitionColumnList});`
          break
        default:
          partitionLine = null
          break
      }

      const newMap = new Map(map)
      const existing = newMap.get(tableName)
      if (existing) {
        existing.columns.push(columnLine)
        if (columnCommentLine) {
          existing.columnComments.push(columnCommentLine)
        }
      } else {
        newMap.set(tableName, {
          columns: [columnLine],
          columnComments: columnCommentLine ? [columnCommentLine] : [],
          comment: commentLine,
          partitionLine,
        })
      }
      return newMap
    },
    new Map<
      string,
      {
        columnComments: string[]
        columns: string[]
        comment: string | null
        partitionLine: string | null
      }
    >(),
  )

  const viewColumnCommentsByViewName = new Map<string, string[]>(
    viewColumnCommentRows.reduce(
      (map, { comment, name, schema_name, view_name }) => {
        const key = `${schema_name}.${view_name}`
        if (!map.has(key)) {
          map.set(key, [])
        }
        map
          .get(key)!
          .push(
            `COMMENT ON COLUMN ${schema_name}.${view_name}.${name} IS ${comment};`,
          )
        return map
      },
      new Map<string, string[]>(),
    ),
  )

  return [...tableColumns.entries()]
    .flatMap(
      ([tableName, { columnComments, columns, comment, partitionLine }]) => [
        [
          [`CREATE TABLE ${tableName} (`],
          [columns.map(column => `    ${column}`).join(",\n")],
          ...(partitionLine ? [")", partitionLine] : [");"]),
        ].join("\n"),
        ...(comment ? [comment] : []),
        ...columnComments,
      ],
    )
    .concat(
      constraintRows.flatMap(
        ({ comment, definition, name, schema_name, table_name }) => [
          [
            `ALTER TABLE ONLY ${schema_name}.${table_name}`,
            `    ADD CONSTRAINT ${name} ${definition};`,
          ].join("\n"),
          ...(comment
            ? [
                `COMMENT ON CONSTRAINT ${name} ON ${schema_name}.${table_name} IS ${comment};`,
              ]
            : []),
        ],
      ),
    )
    .concat(
      viewRows.flatMap(
        ({ comment, definition, is_materialized, name, schema_name }) => [
          [
            `CREATE ${
              is_materialized ? "MATERIALIZED " : ""
            }VIEW ${schema_name}.${name} AS`,
            definition,
          ].join("\n"),
          ...(comment
            ? [
                `COMMENT ON ${
                  is_materialized ? "MATERIALIZED " : ""
                }VIEW ${schema_name}.${name} IS ${comment};`,
              ]
            : []),
          ...(viewColumnCommentsByViewName.get(`${schema_name}.${name}`) ?? []),
        ],
      ),
    )
    .concat(
      [...partitionsByTableName].flatMap(([tableSchemaAndName, partitions]) =>
        partitions.map(
          ({ schema_name, partition_name, partition_definition }) =>
            `ALTER TABLE ONLY ${tableSchemaAndName} ATTACH PARTITION ${schema_name}.${partition_name} ${partition_definition};`,
        ),
      ),
    )
    .join("\n\n\n")
}
