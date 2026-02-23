import type { Client } from "pg"
import { getCreateTableAndViewCommands } from "./get-create-table-and-view-commands"
import { getDomainsAndEnums } from "./get-domains-and-enums"
import { getExtensions } from "./get-extensions"
import { getForeignKeyConstraints } from "./get-foreign-key-constraints"
import { getFunctions } from "./get-functions"
import { getIndexes } from "./get-indexes"
import { getSchemaComments } from "./get-schema-comments"
import { getSequences } from "./get-sequences"
import { getTablesAndViews } from "./get-tables-and-views"
import { getTriggers } from "./get-triggers"

export const getSchema = async (client: Client) => {
  const createTableAndViewCommands = await getCreateTableAndViewCommands(client)
  const hoistedTablesAndViews: string[] = []

  return [
    "SET check_function_bodies = false;",
    ...(await getSchemaComments(client)),
    ...(await getExtensions(client)),
    ...(await getDomainsAndEnums(client)),
    ...(await getSequences(client)),
    // Create functions, hoisting tables and views that are required by functions.
    ...(await getFunctions(
      client,
      createTableAndViewCommands,
      hoistedTablesAndViews,
    )),
    // Create tables and views, skipping hoisted tables and views.
    ...(await getTablesAndViews(
      client,
      createTableAndViewCommands,
      hoistedTablesAndViews,
    )),
    ...(await getIndexes(client)),
    ...(await getTriggers(client)),
    ...(await getForeignKeyConstraints(client)),
  ].join("\n\n\n")
}
