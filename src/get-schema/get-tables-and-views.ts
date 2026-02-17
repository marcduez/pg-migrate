import { escapeIdentifier, escapeLiteral, type Client } from "pg"

export const getTablesAndViews = async (client: Client) => {
  const { rows: columnRows } = await client.query<{
    column_comment: string | null
    column_default_value: string | null
    column_is_not_null: boolean
    column_name: string
    column_type: string
    schema_name: string
    table_name: string
    table_owner_name: string
  }>(`
  select
    pg_namespace.nspname as schema_name
    , pg_class.relname as table_name
    , pg_attribute.attname as column_name
    , pg_get_userbyid(pg_class.relowner) as table_owner_name
    , pg_attribute.attnotnull as column_is_not_null
    , pg_catalog.format_type(pg_attribute.atttypid, pg_attribute.atttypmod) as column_type
    , pg_catalog.pg_get_expr(pg_attrdef.adbin, pg_attrdef.adrelid) as column_default_value
    , col_description(pg_class.oid, pg_attribute.attnum) as column_comment 
  from pg_catalog.pg_attribute
  inner join pg_catalog.pg_class on
    pg_class.oid = pg_attribute.attrelid
  inner join pg_catalog.pg_namespace on
    pg_namespace.oid = pg_class.relnamespace
  left join pg_catalog.pg_attrdef on
    pg_attribute.atthasdef
    and pg_attrdef.adrelid = pg_attribute.attrelid
    and pg_attrdef.adnum = pg_attribute.attnum
  where
    pg_catalog.pg_table_is_visible(pg_class.oid)
    and pg_type_is_visible(pg_attribute.atttypid)  
    and pg_namespace.nspname not in ('pg_catalog', 'information_schema')
    and pg_attribute.attnum > 0
    and not pg_attribute.attisdropped
    and pg_class.relkind = 'r'
  order by 1, 2, 3;`)

  const { rows: constraintRows } = await client.query<{
    comment: string | null
    definition: string
    name: string
    schema_name: string
    table_name: string
  }>(`
  select
	  c.connamespace::regnamespace as schema_name
    , c.conrelid::regclass as table_name
    , quote_ident(c.conname) as name
    , pg_catalog.pg_get_constraintdef(c.oid) as definition
    , quote_literal(d.description) as comment
  from pg_catalog.pg_constraint c
  inner join pg_catalog.pg_namespace n on
	n.oid = c.connamespace
	and n.nspname not in ('pg_catalog', 'information_schema')
  inner join pg_catalog.pg_class table_class on
    table_class.oid = c.conrelid
  left join pg_catalog.pg_description d on
  	d.objoid = c.oid
  	and d.classoid = 'pg_catalog.pg_constraint'::regclass
  where
    pg_catalog.pg_table_is_visible(c.conrelid)
  order by n.nspname, table_class.relname, c.conname`)

  const { rows: partitionedTableRows } = await client.query<{
    schema_name: string
    table_name: string
  }>(`
  select
	  c.relnamespace::regnamespace as schema_name
	  , c.oid::regclass as table_name
  from pg_catalog.pg_class c
  inner join pg_catalog.pg_namespace n on
    n.oid = c.relnamespace
	and n.nspname not in ('pg_catalog', 'information_schema')
  where
  	-- Where kind is partition.
	  c.relkind = 'p'
  order by n.nspname, c.relname`)

  const { rows: viewRows } = await client.query<{
    comment: string | null
    definition: string
    name: string
    schema_name: string
  }>(`
  select
    c.relnamespace::regnamespace as schema_name
    , quote_ident(v.viewname) as name
    , v.definition
	  , quote_literal(d.description) as comment
  from pg_catalog.pg_views v
  inner join pg_class c on
    c.relname = v.viewname
    -- Where kind is view.
    and c.relkind = 'v'
  inner join pg_catalog.pg_namespace n on
  	n.oid = c.relnamespace
  	and n.nspname = v.schemaname
  	and n.nspname not in ('pg_catalog', 'information_schema') 
  left join pg_catalog.pg_description d on
  	d.objoid = c.oid
  	and d.classoid = 'pg_catalog.pg_class'::regclass
  order by n.nspname, v.viewname`)

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
        column_comment,
        column_default_value,
        column_is_not_null,
        column_name,
        column_type,
        schema_name,
        table_name,
        table_owner_name,
      },
    ) => {
      const escapedSchemaName = escapeIdentifier(schema_name)
      const escapedTableName = escapeIdentifier(table_name)
      const tableWithSchema = `${escapedSchemaName}.${escapedTableName}`
      const escapedColumnName = escapeIdentifier(column_name)

      const notNullClause = column_is_not_null ? " NOT NULL" : ""
      const defaultClause = column_default_value
        ? ` DEFAULT ${column_default_value}`
        : ""
      const columnLine = `${escapedColumnName} ${column_type}${defaultClause}${notNullClause}`

      const escapedComment = column_comment
        ? escapeLiteral(column_comment)
        : null
      const commentLine = escapedComment
        ? `COMMENT ON COLUMN ${tableWithSchema}.${escapedColumnName} IS ${escapedComment};`
        : null

      const newMap = new Map(map)
      const existing = newMap.get(tableWithSchema)
      if (existing) {
        existing.columns.push(columnLine)
        if (commentLine) {
          existing.comments.push(commentLine)
        }
      } else {
        newMap.set(tableWithSchema, {
          owner: table_owner_name,
          columns: [columnLine],
          comments: commentLine ? [commentLine] : [],
        })
      }
      return newMap
    },
    new Map<string, { owner: string; columns: string[]; comments: string[] }>(),
  )

  return [...tableColumns.entries()]
    .sort(([tableNameA], [tableNameB]) => tableNameA.localeCompare(tableNameB))
    .map(([tableName, { columns, comments, owner }]) =>
      [
        [`CREATE TABLE ${tableName} (`],
        [columns.map(column => `    ${column}`).join(",\n")],
        [");"],
        [""],
        ...(owner !== "postgres"
          ? [`ALTER TABLE ${tableName} OWNER TO ${owner};`]
          : []),
        ...(comments.length ? ["", comments.join("\n\n")] : []),
      ].join("\n"),
    )
    .concat(
      constraintRows.map(({ definition, name, schema_name, table_name }) => {
        return [
          `ALTER TABLE ONLY ${schema_name}.${table_name}`,
          `    ADD CONSTRAINT ${name} ${definition};`,
        ].join("\n")
      }),
    )
    .concat(
      viewRows.map(({ comment, definition, name, schema_name }) => {
        return [
          `CREATE VIEW ${schema_name}.${name} AS`,
          definition,
          ...(comment
            ? ["", "", `COMMENT ON VIEW ${schema_name}.${name} IS ${comment};`]
            : []),
        ].join("\n")
      }),
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
