# pg-migrate

<span class="badge-npmversion"><a href="https://npmjs.org/package/@marcduez/pg-migrate" title="View this project on NPM"><img src="https://img.shields.io/npm/v/@marcduez/pg-migrate.svg" alt="NPM version" /></a></span>

PostgreSQL database migrations, from script or the command line. There are many packages that do this, but this package makes the following assumptions:

1. Migrations are written in vanilla SQL. This library does not use a DSL for describing changes.
2. Migrations are one-way. There is no support for "down" migrations to undo "up" migrations, because I have never found that useful.
3. Migrations are ordered (e.g. `0004.sql`), but not named (e.g. `0004-create-user-table.sql`). If multiple contributors merge their code after creating migrations, I want them to collide and need resolution.
4. When run from script, this library presumes you bring your own PG client. I like this because it makes it agnostic to how you configure your database. For instance, I like to use [dotenv](https://www.npmjs.com/package/dotenv) to keep development and environment database settings separate.

## Installation

```sh
$ npm install @marcduez/pg-migrate

$ yarn add @marcduez/pg-migrate
```

## General Usage

### Using the CLI

To view usage instructions for the CLI, use the `--help` command:

```sh
$ npm run pg-migrate --help

$ yarn pg-migrate --help
```

### Environment Variables

The CLI accepts the following environment variables:

```
PGURI - Database connection string. When supplied other variables are ignored.
PGUSER - Database user name.
PGHOST - Database server host or socket directory.
PGPASSWORD - Database password.
PGDATABASE - Database name to connect to.
PGPORT - Database server port.
```

Example:

```sh
$ PGURI=postgres://user:password@host:port/database npm run pg-migrate
```

### Creating a migration

In script:

```typescript
import { createDatabaseMigration } from "@marcduez/pg-migrate"

// Your create-database-migration script.
;(async () => {
  const filePath = await createDatabaseMigration()
  // Outputs something like `Database migration created: /path/to/project/migrations/0001.sql`
  console.log(`Database migration created: ${filePath}`)
})()
```

Using the CLI:

```sh
$ npm run pg-migrate create

$ yarn pg-migrate create
```

### Migrating the database

In script:

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

Using the CLI:

```sh
$ npm run pg-migrate migrate

$ yarn pg-migrate migrate
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

### Running a migration without a transaction

Usually each migration is run within a transaction, that is rolled back on error. Some schema updates need to be run outside a transaction. If you want your migration to run outside a transaction, add the line `-- no_transaction` as the first line of your SQL file. Like the following:

```SQL
-- no_transaction

alter type my_enum add value 'new_value';
```

### Pessimistic locking

This library acquires an advisory lock around its work, so if two nodes try to migrate the same database at the same time, one should fail.
