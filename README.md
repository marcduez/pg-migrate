# pg-migrate

PostgreSQL database migrations.

## Installation

```sh
npm install @marcduez/pg-migrate
```

## General Usage

### Creating a migration

```typescript
import { createDatabaseMigration } from "@marcduez/pg-migrate"

// Your create-database-migration script.
;(async () => {
  const filePath = await createDatabaseMigration()
  // Outputs something like `Database migration created: /path/to/project/migrations/0001.sql`
  console.log(`Database migration created: ${filePath}`)
})()
```

### Migrating the database

```typescript
import { createDatabaseMigration } from "@marcduez/pg-migrate"
import { Client } from "pg"

// Your migrate-database script.
;(async () => {
  const client = new Client({
    /* your database config here */
  })
  await client.connect()
  try {
    await migrateDatabase(client)
  } finally {
    await client.end()
  }
})()
```

### Throwing if database is not fully migrated

```typescript
import { databaseNeedsMigration } from "@marcduez/pg-migrate"
import { Client } from "pg"

// Your application entrypoint.
;(async () => {
  const client = new Client({
    /* your database config here */
  })
  await client.connect()
  try {
    if (await databaseNeedsMigration(client)) {
      throw new Error("Database needs migrating!")
    }
  } finally {
    await client.end()
  }

  // Do stuff assuming database is fully migrated.
})()
```
