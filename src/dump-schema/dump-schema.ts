import type { Client } from "pg"
import { getCommentOnSchemaStatements } from "./get-comment-on-schema-statements"
import { getCreateTableAndViewStatements } from "./get-create-table-and-view-statements"
import { getDomainAndEnumStatements } from "./get-domain-and-enum-statements"
import { getExtensionStatements } from "./get-extension-statements"
import { getForeignKeyConstraintStatements } from "./get-foreign-key-constraint-statements"
import { getFunctionStatements } from "./get-function-statements"
import { getIndexStatements } from "./get-index-statements"
import { getSequenceStatements } from "./get-sequence-statements"
import { getTableAndViewStatements } from "./get-table-and-view-statements"
import { getTriggerStatements } from "./get-trigger-statements"

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
