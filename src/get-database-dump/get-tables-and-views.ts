import type { Client } from "pg"

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
    , pg_get_userbyid(pg_class.relowner) as table_owner_name
    , pg_attribute.attname as column_name
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
  order by
    pg_namespace.nspname
    , pg_class.relname
    , pg_attribute.attnum;`)

  const { rows: constraintRows } = await client.query<{
    constraint_definition: string
    constraint_name: string
    constraint_type: "c" | "f" | "n" | "p" | "u" | "t" | "x"
    schema_name: string
    table_name: string
  }>(`
  select
    pg_namespace.nspname as schema_name
    , pg_class.relname as table_name
    , pg_constraint.conname as constraint_name
    , pg_constraint.contype as constraint_type
    , pg_catalog.pg_get_constraintdef(pg_constraint.oid) as constraint_definition
  from pg_catalog.pg_constraint
  inner join pg_catalog.pg_class on
    pg_class.oid = pg_constraint.conrelid
  inner join pg_catalog.pg_namespace ON pg_namespace.oid = pg_class.relnamespace
  where
    pg_catalog.pg_table_is_visible(pg_class.oid)
    and pg_namespace.nspname not in ('pg_catalog', 'information_schema');`)

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
      const tableWithSchema = `${schema_name}.${table_name}`

      const notNullClause = column_is_not_null ? " NOT NULL" : ""
      const defaultClause = column_default_value
        ? ` DEFAULT ${column_default_value}`
        : ""
      const columnLine = `${column_name} ${column_type}${defaultClause}${notNullClause}`

      const escapedComment = column_comment
        ? client.escapeLiteral(column_comment)
        : null
      const commentLine = escapedComment
        ? `COMMENT ON COLUMN ${tableWithSchema}.${column_name} IS ${escapedComment};`
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

  const createTableCommands = [...tableColumns.entries()]
    .sort(([tableNameA], [tableNameB]) => tableNameA.localeCompare(tableNameB))
    .map(([tableName, { columns, comments, owner }]) =>
      [
        [`CREATE TABLE ${tableName} (`],
        [columns.map(column => `  ${column}`).join(",\n")],
        [");"],
        [""],
        [`ALTER TABLE ${tableName} OWNER TO ${owner};`],
        ...(comments.length ? ["", comments.join("\n\n")] : []),
      ].join("\n"),
    )
    .join("\n\n")

  const constraintCommands = constraintRows
    .sort((a, b) => {
      let result = a.schema_name.localeCompare(b.schema_name)
      if (result === 0) {
        result = a.table_name.localeCompare(b.table_name)
      }
      if (result === 0) {
        result = a.constraint_name.localeCompare(b.constraint_name)
      }
      return result
    })
    .map(
      ({ constraint_definition, constraint_name, schema_name, table_name }) =>
        `ALTER TABLE ONLY ${schema_name}.${table_name}\n    ADD CONSTRAINT ${constraint_name} ${constraint_definition};`,
    )
    .join("\n\n")

  return `${createTableCommands}\n\n${constraintCommands}`
}
