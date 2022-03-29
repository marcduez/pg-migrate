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

### Migrating and seeding the database

```typescript
import { createDatabaseMigration, seedDatabase } from "@marcduez/pg-migrate"
import { Client } from "pg"

// Your migrate-database script.
;(async () => {
  const client = new Client({
    /* your database config here */
  })
  await client.connect()
  try {
    await migrateDatabase(client)
    await seedDatabase(client)
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

## Setting Up Local Environment

Even when using `yarn` as package manager, do this login dance with `npm`:

```sh
npm login --scope=@marcduez --registry=https://npm.pkg.github.com
> Username: [your Github username]
> Email: [your Github public email address]
> Password: [a generated personal access token with scopes read:packages and repo]
```

See [this page](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) for more details on using the Github NPM registry.

To generate a personal access token, go [here](https://github.com/settings/tokens).
