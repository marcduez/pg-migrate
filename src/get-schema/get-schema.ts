import type { Client } from "pg"
import { getDomainsAndEnums } from "./get-domains-and-enums"
import { getExtensions } from "./get-extensions"
import { getFunctions } from "./get-functions"
import { getIndexes } from "./get-indexes"
import { getSchemaComments } from "./get-schema-comments"
import { getSequences } from "./get-sequences"
import { getTablesAndViews } from "./get-tables-and-views"
import { getTriggers } from "./get-triggers"

export const getSchema = async (client: Client) =>
  [
    await getSchemaComments(client),
    await getExtensions(client),
    await getDomainsAndEnums(client),
    await getFunctions(client),
    await getSequences(client),
    await getTablesAndViews(client),
    await getIndexes(client),
    await getTriggers(client),
  ]
    .filter(section => !!section)
    .join("\n\n\n")
