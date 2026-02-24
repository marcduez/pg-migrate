import type { Client } from "pg"
import { getCommentOnSchemaStatements } from "./get-comment-on-schema-statements.js"
import { getCreateTableAndViewStatements } from "./get-create-table-and-view-statements.js"
import { getDomainAndEnumStatements } from "./get-domain-and-enum-statements.js"
import { getExtensionStatements } from "./get-extension-statements.js"
import { getForeignKeyConstraintStatements } from "./get-foreign-key-constraint-statements.js"
import { getFunctionStatements } from "./get-function-statements.js"
import { getIndexStatements } from "./get-index-statements.js"
import { getSequenceStatements } from "./get-sequence-statements.js"
import { getTableAndViewStatements } from "./get-table-and-view-statements.js"
import { getTriggerStatements } from "./get-trigger-statements.js"

/**
 * Dumps the schema of a PostgreSQL database as a string of SQL statements that can be used to recreate the schema.
 */
export const dumpSchema = async (client: Client) => {
  const createTableAndViewStatements =
    await getCreateTableAndViewStatements(client)
  const hoistedTablesAndViewNames: string[] = []

  return [
    // Required because the bodies of functions may reference tables and view that have not been created yet.
    "SET check_function_bodies = false;",
    ...(await getCommentOnSchemaStatements(client)),
    ...(await getExtensionStatements(client)),
    ...(await getDomainAndEnumStatements(client)),
    ...(await getSequenceStatements(client)),
    // Get `CREATE FUNCTION` statements, hoisting `CREATE TABLE` and `CREATE VIEW` statements that are required by functions.
    ...(await getFunctionStatements(
      client,
      createTableAndViewStatements,
      hoistedTablesAndViewNames,
    )),
    // Get `CREATE TABLE` and `CREATE VIEW` statements, skipping hoisted statements.
    ...(await getTableAndViewStatements(
      client,
      createTableAndViewStatements,
      hoistedTablesAndViewNames,
    )),
    ...(await getIndexStatements(client)),
    ...(await getTriggerStatements(client)),
    ...(await getForeignKeyConstraintStatements(client)),
  ].join("\n\n\n")
}
