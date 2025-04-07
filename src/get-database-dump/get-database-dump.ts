import type { Client } from "pg"
import { getEnums } from "./get-enums"
import { getExtensions } from "./get-extensions"
import { getFunctions } from "./get-functions"
import { getTablesAndViews } from "./get-tables-and-views"

export const getDatabaseDump = async (client: Client) =>
  [
    await getExtensions(client),
    await getEnums(client),
    await getFunctions(client),
    await getTablesAndViews(client),
  ]
    .filter(section => !!section)
    .join("\n\n")
