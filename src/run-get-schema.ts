import fs from "fs"
import { Client } from "pg"
import { getSchema } from "./get-schema/get-schema"
;(async () => {
  const client = new Client("postgresql://postgres:@localhost:5432/pagila")
  await client.connect()
  const dump = await getSchema(client)
  await client.end()
  await fs.promises.writeFile("get_schema_output.sql", dump)
})()
